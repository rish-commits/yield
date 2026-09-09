import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pickAsks, buildReply } from './questions';
import { makeQuestionGate } from './gate';
import { checkVoiceSupport, transcribe, modelIsCached, VoiceSupport, VOICE_ENABLED } from './whisper';
import { projectPort, probeSequence, inBand, configuredPorts, underRoot, PROBE_LIMIT } from './ports';
import { STORE_HEADER, addNote, countNotes, isLegacyFormat } from './store';
import { isOwnCall, neutralCwd, generateQuestion, Ask } from './ask';
import { ensureHooks, findClaude, settingsPath, SETUP_COPY, SetupState } from './hooks';
import { ensureIgnored } from './ignore';

// Phase 3: the memory loop — listener + store + injection (live).
// Phase A: the panel is the locked design (media/panel.*, from v77).
// Phase B: the three states (cold / with-context / returning) are derived here
//          and pushed to the webview, which is a pure renderer.
// Phase C: the rolling chat stack lives in the webview (motion only).
// Phase D: the reply engine and the four safety behaviours live HERE, not in
//          the webview — so §7's Level 2a becomes one async call in
//          questions.ts with no UI or flow rewrite.
//
// Also live, pulled forward on request: Enter in the composer saves a note, so
// the capture loop stays testable before the Phase C/D chat exists.
//
// Deliberately dumb store: raw prompt, raw note, append-only. No distilling, no
// merging, no cleanup — see "Phase 3 known simplifications" in CLAUDE.md.

const HOST = '127.0.0.1';
const DONE_SETTLE_MS = 2000;

// Handoff §3/§7: shown in the UI as yield-context.md, on disk at
// .yield/yield-context.md. NEVER the user's CLAUDE.md.
const STORE_DIR = '.yield';
const STORE_FILE = 'yield-context.md';


/** Agent timeline — driven entirely by hooks (state model §01). */
type AgentState = 'IDLE' | 'WORKING' | 'DONE';
/** Panel timeline — which of the three renders the card shows (handoff §2). */
type PanelState = 'cold' | 'with-context' | 'returning';

let extensionUri: vscode.Uri;
let panel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;
let doneTimer: ReturnType<typeof setTimeout> | undefined;

// State lives in the extension, not the webview, so the panel can be closed and
// reopened without losing what arrived.
let agentState: AgentState = 'IDLE';

// The task-they're-doing: the most recent prompt text seen on UserPromptSubmit.
// A note typed at any moment is paired with whatever this holds.
let lastPrompt = '';
// Claude Code tells us its cwd; used as the store root only if the extension
// has no workspace folder of its own.
let lastCwd = '';
// Cached so render() stays synchronous; refreshed whenever the store may change.
let noteCount = 0;

// Safety behaviour 2 (flow §06) lives in gate.ts so the rule is testable.
const gate = makeQuestionGate(3);

// ── LLM-generated questions ────────────────────────────────────────────────
// Generated at TASK START, while the agent is already working, so the question
// is waiting by the time anyone looks. `undefined` ask = still generating.
let neutralDir = '';
let cachedAsk: { key: string; ask: Ask | undefined } | undefined;
/** Length of the store when the count was last read — part of the cache key, so
 *  a hand-edit to the file invalidates a question that may now be answered. */
let storeLen = 0;
/** Follow-ups already offered during this wait. Never a chain of 3+. */
let suggestionsThisRound = 0;
const MAX_SUGGESTIONS_PER_ROUND = 2;

// ── setup ──────────────────────────────────────────────────────────────────
// Installing the extension is the consent and the whole setup. Nothing is
// asked, nothing is announced. The ONLY thing the panel ever says is the one
// line for a state the user actually has to act on.
let setupState: SetupState = 'ok';

/**
 * The Claude Code executable findClaude() located, once it has been proven to
 * be one. Passed to the model call so a CLI that is not on the extension
 * host's inherited PATH is still reachable — the `~/.local/bin` case on Linux,
 * and every Windows install, where the name is claude.exe/.cmd rather than
 * `claude`. undefined means "fall back to the bare name", which is exactly
 * what v1 did, so a working setup cannot be made worse by this.
 */
let claudeBin: string | undefined;

/**
 * findClaude() is deliberately generous: it accepts `~/.claude` — a DIRECTORY
 * — as evidence Claude Code exists, which is right for deciding whether to
 * install hooks and wrong for spawning. Anything that is not a real executable
 * file is dropped here rather than handed to spawn.
 */
async function usableBinary(p: string | undefined): Promise<string | undefined> {
  if (!p) { return undefined; }
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) { return undefined; }   // ~/.claude, the directory
    // Windows has no execute bit; the extension is the permission check there.
    if (process.platform !== 'win32') { await fs.access(p, fs.constants.X_OK); }
    return p;
  } catch {
    return undefined;
  }
}
/** Has any hook reached us since activation? The restart line exists only for
 *  someone whose Claude Code was already running when the hooks appeared, and
 *  the first hook proves that is no longer true. */
let hookEverFired = false;

/** What the listener is doing. Every value is a state with an end, never a
 *  loop: `claiming` becomes either `listening` or `no-port`. */
type ListenerState = 'claiming' | 'listening' | 'no-port';
let listenerState: ListenerState = 'claiming';

/** Phase E's rule, made structural: never push at a webview that has not said
 *  it can hear. Setup finishes asynchronously and would otherwise render into
 *  a panel that is still loading, and that push would simply be dropped. */
let webviewReady = false;

// Voice (stage 2). The model is ~141 MB and is NOT in the VSIX: it downloads
// once into the extension's global storage. The binary IS in the VSIX, at
// bin/whisper/, and is arm64-macOS only — `voice` records whether this machine
// can run it at all, so the mic can be honestly disabled instead of failing
// when clicked.
let modelCacheDir = '';
let voice: VoiceSupport = { ok: false, reason: 'not checked yet' };
let transcribing = false;

/** Per-workspace memory that we have already written the .gitignore entry.
 *  Its absence is the ONLY thing that lets us write it. */
const IGNORE_DONE = 'yield.gitignoreWritten';

export function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  output = vscode.window.createOutputChannel('Yield');
  context.subscriptions.push(output);
  // Which build is actually running. media/*.html is read from disk at runtime
  // but this file is loaded at activation, so after installing a VSIX without
  // reloading the window the two can disagree — this line is how you tell.
  note(`Yield v${context.extension.packageJSON.version} active`);

  modelCacheDir = context.globalStorageUri.fsPath;
  // Outside every workspace, so a spawned call loads no project hooks.
  void neutralCwd(modelCacheDir).then((d) => { neutralDir = d; });
  // The flag comes first: with it off nothing voice-related is even probed, and
  // runTranscription refuses, so no host-side voice work can run.
  voice = VOICE_ENABLED
    ? checkVoiceSupport(extensionUri.fsPath)
    : { ok: false, reason: 'Voice is disabled in this build' };
  note(VOICE_ENABLED
    ? (voice.ok ? `voice: available (${voice.binary})` : `voice: unavailable — ${voice.reason}`)
    : 'voice: disabled (VOICE_ENABLED=false) — mic hidden, no voice path active');

  const open = vscode.commands.registerCommand('yield.open', async () => {
    if (panel) {
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }

    // ViewColumn puts this in the editor area as a real tab, so it can be
    // dragged to any dock region or floated out.
    panel = vscode.window.createWebviewPanel(
      'yield.panel',
      'Yield',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // Fonts, stylesheet, script and logo are served from media/.
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
      }
    );

    // The file affordance is live the moment the panel is, so make sure there is
    // a file behind it before anyone can click.
    await ensureStore();
    await refreshNoteCount();
    panel.webview.html = await getHtml(panel.webview);
    panel.webview.onDidReceiveMessage(
      (msg) => {
        // The webview announces itself once its message listener is live. Until
        // that lands, anything we post is dropped on the floor — which is how a
        // panel opened DURING a run used to sit on a stale "Idle" chip for the
        // whole turn. The first real render is this reply, not a hopeful push.
        if (msg?.type === 'ready') {
          webviewReady = true;
          note('webview ready — pushing live state');
          render();
          return;
        }
        if (msg?.type === 'note' && typeof msg.text === 'string') {
          gate.engage();
          void saveNote(msg.text, typeof msg.answering === 'string' ? msg.answering : undefined);
          return;
        }
        if (msg?.type === 'engaged') {
          gate.engage(); // they took a question up
          return;
        }
        // Handoff §6: the footer (and the header's file icon) are the ONLY
        // history affordance — the file IS the archive. "Always visible,
        // editable, clearable" is a stated constraint, and this is the door.
        if (msg?.type === 'openStore') {
          void openStore();
          return;
        }
        // Voice: the webview hands over a finished 16 kHz WAV and gets back a
        // string. Same shape as the reply engine — all the work is here, the
        // webview only renders the result.
        if (msg?.type === 'transcribe' && typeof msg.wav === 'string') {
          void runTranscription(msg.wav);
          return;
        }
        // The webview could not even reach the capture API. Worth a log line
        // rather than a silent dead click — this is how the v1 blocker showed up.
        if (msg?.type === 'voiceUnavailable') {
          note(`voice unavailable in the webview: ${String(msg.reason || 'unknown')}`);
        }
      },
      null,
      context.subscriptions
    );
    panel.onDidDispose(() => { panel = undefined; webviewReady = false; }, null, context.subscriptions);
    // No eager render here: see the `ready` branch above.
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('yield.smartSuggestions')) { return; }
      note(`smart suggestions turned ${smartSuggestions() ? 'on' : 'off'}`);
      // Drop anything the model wrote, so the panel swaps over on the spot.
      cachedAsk = undefined;
      render();
      if (smartSuggestions()) { void startQuestionGeneration(); }
    })
  );

  context.subscriptions.push(open);

  // Recovery only. Normal onboarding never needs this: setup runs on
  // activation. It exists for a user whose settings got into a state Yield
  // refused to touch, or who wiped them.
  context.subscriptions.push(
    vscode.commands.registerCommand('yield.installHooks', () => runSetup(true))
  );
  void startListening(context);
  void setUpIgnore(context);   // notes are private by default
  void refreshNoteCount();
}

export function deactivate() {
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = undefined; }
  stopListening();
  panel?.dispose();
  panel = undefined;
}

// ---------------------------------------------------------------- the store

// Yield owns .yield/yield-context.md. It never reads or writes the user's CLAUDE.md.
function storePath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? lastCwd;
  return root ? path.join(root, STORE_DIR, STORE_FILE) : undefined;
}

/** The store for an arbitrary project root — used to serve a hook that came
 *  from a different window's project. */
async function readStoreAt(root: string): Promise<string> {
  if (!root) { return ''; }
  try {
    return await fs.readFile(path.join(root, STORE_DIR, STORE_FILE), 'utf8');
  } catch {
    return '';
  }
}

async function readStore(): Promise<string> {
  const file = storePath();
  if (!file) { return ''; }
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      note(`store read failed: ${(err as Error).message}`);
    }
    return '';
  }
}

async function refreshNoteCount(): Promise<number> {
  const store = await readStore();
  noteCount = countNotes(store);
  storeLen = store.length;
  return noteCount;
}

/** Identity of a cached question: the task it was written for, plus a
 *  fingerprint of the file it was written against. Either changing means the
 *  question may no longer be the right one to ask. */
function askKey(task: string): string {
  return `${task}\u0000${noteCount}\u0000${storeLen}`;
}

/**
 * Every reason NOT to spend a model call, in one place. Checked BEFORE spawning,
 * never after — a user who ignores questions should cost nothing at all.
 */
function smartSuggestions(): boolean {
  // Read fresh every time, never cached, so the toggle takes effect on the very
  // next call with no reload.
  return vscode.workspace.getConfiguration('yield').get<boolean>('smartSuggestions', true);
}

function mayGenerate(): boolean {
  // Checked FIRST, so switching it off means no subprocess is ever spawned —
  // not a call that gets discarded later in the pipeline.
  if (!smartSuggestions()) { return false; }
  if (!panel) { return false; }        // a closed panel cannot show a question
  if (gate.muted) { return false; }    // read the room; they stopped engaging
  if (!lastPrompt.trim()) { return false; }
  return true;
}

/** Moment A: generate at task start, cache it, and let render() pick it up. */
async function startQuestionGeneration() {
  if (!mayGenerate()) {
    note(`no question generated: ${!smartSuggestions() ? 'smart suggestions are off'
      : !panel ? 'panel closed' : gate.muted ? 'questions muted' : 'no task yet'}`);
    return;
  }
  const key = askKey(lastPrompt);
  cachedAsk = { key, ask: undefined };   // pending — render() shows nothing yet
  render();

  const store = await readStore();
  const ask = await generateQuestion({ task: lastPrompt, store, cwd: neutralDir, binary: claudeBin });

  // A newer task started while we were generating; that result is stale.
  if (!cachedAsk || cachedAsk.key !== key) {
    note('generated question discarded: the task moved on');
    return;
  }
  cachedAsk = { key, ask };
  note(ask.kind === 'question' ? `question: ${ask.text}`
     : ask.kind === 'silent' ? 'model had nothing worth asking — staying quiet'
     : `question generation failed (${ask.reason}) — falling back to the scripted one`);
  render();
}

/**
 * Write, then rename. A crash mid-write leaves the temp file behind and the
 * real one untouched, rather than a half-written brief. rename(2) is atomic
 * within a filesystem.
 */
async function writeAtomic(file: string, contents: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, contents, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function saveNote(raw: string, answeringId?: string) {
  const text = raw.trim();
  if (!text) { return; } // empty save is a no-op (state model §06)

  const file = storePath();
  if (!file) {
    note('NOT saved: no workspace folder and no cwd seen yet — nowhere to write.');
    panel?.webview.postMessage({ type: 'saveFailed' });
    return;
  }

  try {
    // Read, insert one bullet, write the whole file back atomically. The
    // prompt is NEVER written: the file is a brief about the project, not a
    // record of what was asked. Everything the user typed goes in verbatim.
    const before = await readStore();
    const after = addNote(before || STORE_HEADER, text);
    await writeAtomic(file, after);

    note(`saved: ${text}`);
    await refreshNoteCount();
    panel?.webview.postMessage({ type: 'saved' });
    render(); // a first note flips the panel to `returning`

    // Handoff §5: honest ack (+ keyword echo when a term is really present)
    // plus a soft optional door. Never a re-ask, never a dead end.
    const reply = buildReply(text, answeringId);
    note(`reply: ${reply}`);
    panel?.webview.postMessage({ type: 'reply', text: reply });

    // Moment B. The ack above is instant and scripted; this arrives after it,
    // so the model's latency is covered by something already on screen.
    void followUp(text);
  } catch (err) {
    note(`save FAILED: ${(err as Error).message}`);
    panel?.webview.postMessage({ type: 'saveFailed' });
  }
}

/**
 * Moment B: one gentle follow-up after a note, never a chain. Saving a note IS
 * engagement, so the gate allows it — but the per-round cap stops us talking at
 * someone who is writing several notes in one wait.
 */
async function followUp(text: string) {
  if (suggestionsThisRound >= MAX_SUGGESTIONS_PER_ROUND) {
    note('no follow-up: already suggested twice this wait');
    return;
  }
  if (!mayGenerate()) {
    // Previously a silent return, which made this exact case undiagnosable from
    // the Output channel: the follow-up simply never appeared and said nothing.
    note(`no follow-up: ${!smartSuggestions() ? 'smart suggestions are off'
      : !panel ? 'panel closed' : gate.muted ? 'questions muted' : 'no task yet'}`);
    return;
  }
  suggestionsThisRound++;

  const store = await readStore();
  // The NOTE is the primary input here, not the task: the follow-up should read
  // as a response to what they just wrote, not a fresh prompt about something
  // adjacent. generateQuestion falls back to task-framing when it is absent.
  const ask = await generateQuestion({ task: lastPrompt, store, note: text, cwd: neutralDir, binary: claudeBin });
  if (ask.kind === 'question') {
    note(`suggestion: ${ask.text}`);
    panel?.webview.postMessage({ type: 'suggest', text: ask.text });
  } else {
    // Silence and failure both mean nothing more is said. A follow-up is a
    // bonus, so unlike the question there is no scripted stand-in.
    note(ask.kind === 'silent' ? 'no follow-up: nothing worth suggesting'
                               : `no follow-up: ${ask.reason}`);
  }
}

/**
 * Creates `.yield/yield-context.md` if it is not there yet, seeded with the
 * header. Called when the PANEL OPENS rather than on activation: activation
 * fires in every window (`onStartupFinished`), so seeding there would drop a
 * `.yield/` folder into every workspace the user ever opens, including ones
 * where they never touch Yield. Opening the panel is a deliberate act in a
 * specific workspace, and the file affordance only exists once the panel is up,
 * so this is early enough that a click can never land on a missing file.
 */
async function ensureStore(): Promise<boolean> {
  const file = storePath();
  if (!file) { return false; }
  try {
    await fs.access(file);
    await archiveLegacyStore(file);
    return true;
  } catch {
    try {
      await writeAtomic(file, STORE_HEADER);
      note(`seeded ${STORE_DIR}/${STORE_FILE}`);
      return true;
    } catch (err) {
      note(`could not seed the store: ${(err as Error).message}`);
      return false;
    }
  }
}

/**
 * The old format paired every note with the full prompt that prompted it, so
 * the file was mostly transcript. It is not converted — the content was
 * bookkeeping, not a brief. It is moved aside intact and a clean file started,
 * so nothing the user wrote is ever destroyed.
 */
async function archiveLegacyStore(file: string) {
  let existing: string;
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  if (!isLegacyFormat(existing)) { return; }

  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  let archive = path.join(path.dirname(file), `yield-context-archive-${stamp}.md`);
  for (let n = 2; ; n++) {
    try {
      await fs.access(archive);
      archive = path.join(path.dirname(file), `yield-context-archive-${stamp}-${n}.md`);
    } catch {
      break;
    }
  }
  await fs.rename(file, archive);
  await writeAtomic(file, STORE_HEADER);
  note(`previous context archived to ${path.basename(archive)}; started a clean brief`);
}

/** Opens the store in a real editor tab. Seeds it first if it somehow is not
 *  there, so the affordance is never a dead end — clicking always lands on the
 *  actual file, which is the whole legibility promise. */
async function openStore() {
  const file = storePath();
  if (!file) {
    note('cannot open the store: no workspace folder and no cwd seen yet.');
    vscode.window.showWarningMessage(
      'Yield: no folder is open, so there is nowhere to keep yield-context.md yet.'
    );
    return;
  }
  try {
    await ensureStore();
    // No forced column: `vscode.open` uses the active group and respects the
    // user's editor settings. `preview: true` reuses the same tab, so clicking
    // the footer ten times leaves one tab, not ten.
    await vscode.commands.executeCommand(
      'vscode.open',
      vscode.Uri.file(file),
      { preview: true }
    );
    note(`opened ${STORE_DIR}/${STORE_FILE}`);
    // They may edit or clear it from here, so re-derive the count on the way in.
    await refreshNoteCount();
    render();
  } catch (err) {
    note(`open FAILED: ${(err as Error).message}`);
    vscode.window.showErrorMessage(`Yield: could not open ${STORE_FILE} — ${(err as Error).message}`);
  }
}

/**
 * WAV in, transcript out. The result lands in the COMPOSER as editable text —
 * it is never auto-saved and never bypasses review (state model: speak →
 * transcribe → review → save). Saving stays the user's deliberate act.
 */
async function runTranscription(wavBase64: string) {
  if (!voice.ok) {
    note(`transcribe refused: ${voice.reason}`);
    panel?.webview.postMessage({ type: 'voiceFailed', reason: voice.reason });
    return;
  }
  if (transcribing) {
    note('transcribe ignored: one already running');
    return;
  }
  transcribing = true;
  const started = Date.now();
  try {
    const wav = Buffer.from(wavBase64, 'base64');
    const cold = !(await modelIsCached(modelCacheDir));
    note(`transcribing ${(wav.length / 1024).toFixed(0)} KB of audio${cold ? ' (model not cached yet)' : ''}`);

    const text = await transcribe({
      wav,
      extensionRoot: extensionUri.fsPath,
      cacheDir: modelCacheDir,
      onStage: (stage, pct) => {
        // One-time "downloading model…" state, then the transcribing beat.
        panel?.webview.postMessage({ type: 'voiceStage', stage, pct });
      }
    });

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!text) {
      note(`transcribed in ${secs}s but heard nothing`);
      panel?.webview.postMessage({ type: 'voiceFailed', reason: 'Nothing was picked up' });
      return;
    }
    note(`transcribed in ${secs}s${cold ? ' (cold)' : ' (warm)'}: ${text}`);
    panel?.webview.postMessage({ type: 'transcript', text });
  } catch (err) {
    const reason = (err as Error).message;
    note(`transcribe FAILED: ${reason}`);
    panel?.webview.postMessage({ type: 'voiceFailed', reason });
  } finally {
    transcribing = false;
  }
}

// ------------------------------------------------------------- the listener
//
// v1 bound ONE fixed port from every window, so several windows raced for it and
// the losers went permanently deaf WITHOUT SAYING SO. Deriving the port from
// the workspace fixed most of that, but a 100-port band meant a dozen projects
// had a coin-flip chance of some pair colliding, and a collision left the second
// window deaf forever while retrying every 3s.
//
// PROBE AND CLAIM. A window tries its preferred port, and if that is taken it
// probes upward until it holds one. It never waits for someone else to let go,
// so two colliding projects both work at the same time.
//
// THE ORDER IS THE WHOLE POINT: bind FIRST, then write the port into the
// project's hooks. The hook URL must always name the port this window actually
// holds. Checking whether a port is free and then binding it leaves a gap in
// which two windows both decide it is theirs.
//
// Everything here is bounded. The probe stops after PROBE_LIMIT ports, the
// retry stops after MAX_CLAIM_ATTEMPTS, and what is left is a named state with
// its own line in the panel. Notes save regardless: capture never depends on
// the connection.

const CLAIM_RETRY_MS = 5000;
/** Bounded, with an end state. Nothing here retries forever. */
const MAX_CLAIM_ATTEMPTS = 5;
/** Remembered per project, so a window keeps its port across launches instead
 *  of drifting and demanding a Claude Code restart every time it opens. */
const PORT_KEY = 'yield.claimedPort';
/** Where probing starts when there is no folder open to hash. */
const PORT_BASE_FALLBACK = 41800;

let server: http.Server | undefined;
let claimTimer: ReturnType<typeof setTimeout> | undefined;
let claimAttempts = 0;
/** The port this window actually holds. Never assumed — only ever set after a
 *  successful bind, because the settings file is written from it. */
let primaryPort = 0;

/** True when we hold a port, i.e. the panel can actually hear the agent. */
function isListening(): boolean {
  return !!server && server.listening;
}

function makeServer(port: number): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let event = 'unknown';
      let prompt = '';
      let cwd = '';
      try {
        const payload = JSON.parse(body || '{}');
        event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown';
        // Phase 0 finding: the prompt text is in `prompt`, NOT `user_input`.
        prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
        cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
        if (cwd) { lastCwd = cwd; }
      } catch {
        note(`unparseable body: ${body.slice(0, 200)}`);
      }

      // OUR OWN generation call, coming back at us. Yield spawns `claude -p` to
      // write a question; if that call fires this hook, Yield asks itself for a
      // question forever. The spawn already runs from a neutral cwd, which
      // loads no project hooks — but that only holds while nobody has a hook in
      // ~/.claude/settings.json, and the day one appears the loop returns
      // silently. The sentinel rides in the prompt and makes that a no-op.
      if (isOwnCall(prompt)) {
        note('ignored our own generation call (sentinel)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      // Only react to work happening in OUR project. On the shared legacy port
      // another window's session can reach us, and flipping this panel's chip
      // for someone else's run is exactly the confusion we are fixing.
      if (isOurs(cwd)) {
        handleEvent(event, prompt);
      } else {
        note(`${event} from ${cwd} — not this window's project, panel not touched`);
      }

      // One round-trip does both jobs: the panel already reacted above, and the
      // reply body carries the store back to the agent. A 2xx JSON body is
      // parsed like command-hook output (Phase 0 finding). The store served is
      // the CALLER'S, never ours — injecting one project's notes into another
      // project's session would be worse than injecting nothing.
      void reply(res, event, cwd);
    });
  });
}

/**
 * Whether a hook's cwd belongs to the project this window has open. The
 * comparison itself lives in ports.ts (underRoot) because it is platform
 * -sensitive and worth testing without a vscode stub.
 */
function isOurs(cwd: string): boolean {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return underRoot(cwd, root ?? '');
}

/**
 * One bind attempt. BIND FIRST — never check-then-bind, which leaves a gap in
 * which two windows starting at the same instant both decide a port is free.
 * The only way to know a port is yours is to hold it.
 */
function tryBind(port: number): Promise<http.Server | undefined> {
  return new Promise((resolve) => {
    const s = makeServer(port);
    let settled = false;
    const done = (v: http.Server | undefined) => {
      if (settled) { return; }
      settled = true;
      resolve(v);
    };
    s.on('error', (err: NodeJS.ErrnoException) => {
      // EADDRINUSE is expected and just means "try the next one". Anything else
      // is reported so an unexpected failure is never silent.
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        note(`bind error on ${port}: ${err.message}`);
      }
      try { s.close(); } catch { /* never listened */ }
      done(undefined);
    });
    s.listen(port, HOST, () => done(s));
  });
}

/**
 * Walks the probe order until a port is actually held, or the bound runs out.
 * Returns the port we own; `undefined` means every port we tried was taken,
 * which is a real state with its own message rather than a reason to spin.
 */
async function claimPort(preferred: number, remembered?: number): Promise<number | undefined> {
  for (const port of probeSequence(preferred, remembered)) {
    const s = await tryBind(port);
    if (s) {
      server = s;
      s.on('close', () => { server = undefined; render(); });
      return port;
    }
  }
  return undefined;
}

/**
 * Claim a port, then write it into this project's hooks.
 *
 * The order matters and is the whole point: the hook URL must always name the
 * port this window actually holds. Writing settings before the bind could leave
 * a project pointing at a port someone else owns, which is worse than waiting.
 */
async function startListening(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const preferred = root ? projectPort(root) : PORT_BASE_FALLBACK;
  const remembered = context.workspaceState.get<number>(PORT_KEY);

  const claimed = await claimPort(preferred, inBand(remembered) ? remembered : undefined);

  if (claimed === undefined) {
    claimAttempts++;
    if (claimAttempts < MAX_CLAIM_ATTEMPTS) {
      note(`no free port in ${PROBE_LIMIT} tried; attempt ${claimAttempts} of ${MAX_CLAIM_ATTEMPTS}, retrying in ${CLAIM_RETRY_MS / 1000}s`);
      claimTimer = setTimeout(() => { void startListening(context); }, CLAIM_RETRY_MS);
    } else {
      // Terminal, and said out loud. Notes still save; only the connection is gone.
      note(`gave up claiming a port after ${MAX_CLAIM_ATTEMPTS} attempts. Notes still save; reload the window to try again.`);
    }
    listenerState = claimAttempts >= MAX_CLAIM_ATTEMPTS ? 'no-port' : 'claiming';
    render();
    return;
  }

  claimAttempts = 0;
  listenerState = 'listening';
  primaryPort = claimed;
  note(`listening on http://${HOST}:${claimed}`
    + (claimed === preferred ? '' : ` (preferred ${preferred} was taken)`));
  await context.workspaceState.update(PORT_KEY, claimed);
  render();

  // Only now, holding the port, do we tell the project where to dial.
  await runSetup();
}

function stopListening() {
  if (claimTimer) { clearTimeout(claimTimer); claimTimer = undefined; }
  server?.close();
  server = undefined;
}

/**
 * Puts Yield's hooks in place, silently, on activation.
 *
 * A new user should install the extension and start using it. No config file to
 * write, no steps to follow, no dialog to dismiss. Everything that can go wrong
 * turns into ONE honest line in the panel rather than a dead panel with no
 * explanation.
 */
async function runSetup(announce = false) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const claudePath = await findClaude();
  const result = await ensureHooks(root, primaryPort, { claudePath });

  claudeBin = await usableBinary(claudePath);
  note(claudeBin
    ? `claude binary: ${claudeBin}`
    : `claude binary: not resolved to an executable${claudePath ? ` (${claudePath})` : ''} — the model call will try the bare name`);

  setupState = result.state;
  if (result.path) { note(`Claude Code settings: ${result.path}`); }

  if (result.state === 'restart-needed') {
    note(`hooks installed for this project on port ${primaryPort}`);
    note('RESTART CLAUDE CODE to activate them — hooks are read once when a session starts.');
  } else if (result.state === 'ok') {
    note('hooks already in place');
  } else {
    note(`setup: ${result.state}${result.detail ? ` (${result.detail})` : ''}`);
  }

  // Only the recovery command speaks up; normal activation stays silent.
  if (announce) {
    const msg = result.state === 'ok' ? 'Yield: hooks are already in place.'
      : result.state === 'restart-needed' ? 'Yield: hooks installed. Restart Claude Code to activate them.'
      : `Yield: ${SETUP_COPY[result.state]}`;
    void vscode.window.showInformationMessage(msg);
  }
  render();
}

/**
 * Notes are private by default: `.yield/` goes into .gitignore on first run.
 *
 * Deliberately silent, and deliberately once. Removing that line is how a team
 * opts into sharing context, so the memory of having written it lives in
 * workspaceState and is never re-derived from whether the line is currently
 * there — otherwise the next activation would quietly undo their decision.
 */
async function setUpIgnore(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const done = context.workspaceState.get<boolean>(IGNORE_DONE, false);
  const r = await ensureIgnored(root, done);

  if (r.state === 'added' || r.state === 'already-present') {
    // Either way we are finished here, permanently.
    await context.workspaceState.update(IGNORE_DONE, true);
  }
  if (r.state === 'added') { note('added .yield/ to .gitignore so notes stay local'); }
  else if (r.state === 'failed') { note(`could not update .gitignore: ${r.detail}`); }
}

/**
 * The one line the panel shows, or '' when everything is fine.
 *
 * Ordered by what the user can actually act on. A hook that has reached us
 * proves the whole chain works, so that outranks everything: no line at all.
 * Otherwise a listener that never got a port is the most urgent thing to say,
 * because nothing else can work until it does.
 */
function setupNote(): string {
  if (hookEverFired) { return ''; }
  if (listenerState === 'no-port') { return SETUP_COPY['no-port']; }
  return SETUP_COPY[setupState] || '';
}

async function reply(res: http.ServerResponse, event: string, cwd: string) {
  let payload: unknown = {};

  if (event === 'UserPromptSubmit') {
    // Serve the CALLER's store, so a window that happens to hold the shared
    // port never injects its own project's notes into someone else's session.
    const store = (await readStoreAt(cwd) || await readStore()).trim();
    if (isOurs(cwd)) {
      await refreshNoteCount(); // the file is hand-editable; re-derive every turn
      render();
    }
    if (store) {
      payload = {
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: injection(store)
        },
        // Phase 0 finding: keeps the injection out of the transcript while
        // still feeding it to the agent.
        suppressOutput: true
      };
      note(`injected ${store.length} chars of context`);
    } else {
      note('no stored context to inject yet');
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function injection(store: string): string {
  return [
    `Project context and standing instructions for this repository, from ${STORE_DIR}/${STORE_FILE}.`,
    'These are the user\'s own words. Treat them as standing preferences that apply now,',
    'and where two entries conflict, prefer the later one.',
    '',
    `--- begin ${STORE_DIR}/${STORE_FILE} ---`,
    store,
    `--- end ${STORE_DIR}/${STORE_FILE} ---`
  ].join('\n');
}

function handleEvent(event: string, prompt: string) {
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = undefined; }
  // Proof the hooks are live. The setup line never comes back after this.
  if (!hookEverFired) {
    hookEverFired = true;
    note('first hook received — setup is confirmed working');
  }

  if (event === 'UserPromptSubmit') {
    // Judge the round that just ended before opening the next one.
    if (gate.closeRound()) {
      note(`questions muted for this session after ${gate.ignoredRounds} ignored rounds`);
    }
    if (prompt) { lastPrompt = prompt; }
    const preview = prompt ? ` "${prompt.slice(0, 40).replace(/\s+/g, ' ')}"` : ' (no prompt text)';
    setState('WORKING', `UserPromptSubmit → WORKING${preview}`);

    // A new task invalidates the previous question and reopens the follow-up
    // budget. Generation runs inside a wait that was already happening.
    cachedAsk = undefined;
    suggestionsThisRound = 0;
    void startQuestionGeneration();
    return;
  }

  if (event === 'Stop') {
    setState('DONE', 'Stop → DONE');
    doneTimer = setTimeout(() => {
      doneTimer = undefined;
      setState('IDLE', 'settled → IDLE');
    }, DONE_SETTLE_MS);
    return;
  }

  note(`${event} → (ignored this phase)`);
}

function setState(next: AgentState, line: string) {
  const before = statusLabel();
  agentState = next;
  const after = statusLabel();
  note(line);
  // The chip is the only part of the lifecycle the user can SEE, so say what it
  // now reads. A run that logs WORKING but never "chip: → Agent is working" is
  // a render that did not land.
  if (before !== after) { note(`chip: ${before} → ${after}`); }
  render();
}

function note(line: string) {
  output.appendLine(`${stamp()}  ${line}`);
}

// ------------------------------------------------------- what the panel shows

/**
 * Handoff §2. Three states, derived — never guessed:
 *   returning     — they have notes, so they know the mechanism. Descriptor hidden.
 *   with-context  — no notes yet, but a live task to key questions off.
 *   cold          — no notes and no task signal. Nothing legit to ask, so silence.
 */
function panelState(): PanelState {
  if (noteCount > 0) { return 'returning'; }
  return lastPrompt ? 'with-context' : 'cold';
}

/** Handoff §7: the chip is the hook lifecycle made visible. WORKING is the only
 *  state with its own label — the state model's §07 has Stop return straight to
 *  IDLE, and DONE is only the internal settle before it. Agent-neutral voice. */
function statusLabel(): string {
  // A panel that cannot hear the agent must SAY so. Reporting "Idle" while deaf
  // is a lie that cost real debugging time twice. Quiet and factual, not an
  // alarm: input still works and still saves (state model §06).
  if (!isListening()) { return 'Not hearing the agent'; }
  return agentState === 'WORKING' ? 'Agent is working' : 'Idle';
}

/** Handoff §6: filename at zero notes, then "1 note", then "N notes". Computed
 *  HERE, not in the webview, so the renderer stays a renderer. */
function noteLabel(): string {
  if (!noteCount) { return STORE_FILE; }
  return noteCount === 1 ? '1 note' : `${noteCount} notes`;
}

function cardClass(): string {
  const state = panelState();
  return [
    'card',
    VOICE_ENABLED ? '' : 'no-voice',
    isListening() ? '' : 'deaf',
    agentState === 'WORKING' ? 'working' : '',
    state === 'returning' ? 'returning' : '',
    state === 'cold' ? 'coldstart' : ''
  ].filter(Boolean).join(' ');
}

/**
 * Which question the panel shows. THREE outcomes, deliberately distinct:
 *   generated  — show it
 *   silent     — show NOTHING. The model looked and had nothing worth asking;
 *                that is a designed feature, never papered over with a canned line.
 *   failed     — show the SCRIPTED question. There was a real reason to ask and
 *                the model simply was not there.
 * While a generation is still in flight nothing is shown, so the question never
 * visibly swaps out from under someone mid-read.
 */
function currentAsks(): { id: string; text: string }[] {
  if (panelState() === 'cold' || gate.muted) { return []; }

  // Smart suggestions off: the scripted question is the product, exactly as it
  // was in v1. Not a degraded mode, just the other one.
  if (!smartSuggestions()) {
    return pickAsks(lastPrompt).map((a) => ({ id: a.id, text: a.question }));
  }

  const c = cachedAsk;
  if (c && c.key === askKey(lastPrompt)) {
    if (!c.ask) { return []; }                                   // still generating
    if (c.ask.kind === 'silent') { return []; }                   // designed silence
    if (c.ask.kind === 'question') { return [{ id: 'llm', text: c.ask.text }]; }
    // 'failed' falls through to the script below
  }
  return pickAsks(lastPrompt).map((a) => ({ id: a.id, text: a.question }));
}

function render() {
  const asks = currentAsks();
  if (asks.length) { gate.offer(); }

  if (!webviewReady) { return; }   // it cannot hear us yet; `ready` will ask
  panel?.webview.postMessage({
    type: 'render',
    cardClass: cardClass(),
    statusLabel: statusLabel(),
    listening: isListening(),
    // Carries the id so the reply engine knows which question got answered.
    questions: asks,
    noteLabel: noteLabel(),
    // `enabled` decides whether the mic exists at all; `ok` decides whether it
    // is usable when it does.
    voice: { enabled: VOICE_ENABLED, ok: voice.ok, reason: voice.ok ? '' : voice.reason },
    setupNote: setupNote()
  });
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}


async function getHtml(webview: vscode.Webview): Promise<string> {
  // The design is the locked mock; it lives as real files under media/ so the
  // stylesheet stays diffable against yield-panel-mock-v77.html.
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  const asUri = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
  const nonce = makeNonce();

  // Every asset the page actually pulls, checked and named — so a broken image
  // says whether the file is missing, or present but resolving to a URI the
  // webview rejected. The wordmark is NOT in this list: it is inline SVG in
  // panel.html now (media/yield-wordmark.svg is only where that markup came
  // from), which is precisely why it can no longer fail this way.
  for (const asset of ['panel.css', 'panel.js', 'wav.js', 'yield-logo.svg']) {
    try {
      await fs.access(vscode.Uri.joinPath(media, asset).fsPath);
    } catch {
      note(`MISSING ASSET: media/${asset} is not on disk in this install`);
    }
  }
  note(`assets: logo=${asUri('yield-logo.svg')}`);

  const html = await fs.readFile(vscode.Uri.joinPath(media, 'panel.html').fsPath, 'utf8');
  const filled = html
    .split('{{cspSource}}').join(webview.cspSource)
    .split('{{nonce}}').join(nonce)
    .split('{{styleUri}}').join(asUri('panel.css'))
    .split('{{scriptUri}}').join(asUri('panel.js'))
    .split('{{wavUri}}').join(asUri('wav.js'))
    .split('{{logoUri}}').join(asUri('yield-logo.svg'))
    // Painted server-side so the first frame is already the right state. All
    // three come from the same helpers render() uses, so the opening frame can
    // never disagree with itself — no green dot over an "Idle" label.
    .split('{{cardClass}}').join(cardClass())
    .split('{{statusLabel}}').join(statusLabel())
    .split('{{footerLabel}}').join(noteLabel());

  // A leftover {{placeholder}} means panel.html is newer than this file — the
  // classic "installed the VSIX but didn't reload the window". It would show up
  // only as a silently broken image, so say it out loud instead.
  const leftover = [...new Set(filled.match(/{{\w+}}/g) ?? [])];
  if (leftover.length) {
    const detail = `panel.html wants ${leftover.join(', ')}, which this build does not fill. Reload the window (the HTML is read from disk, this code is not).`;
    note(`ASSET WIRING: ${detail}`);
    output.show(true);
    vscode.window.showWarningMessage(`Yield: ${detail}`);
  }
  return filled;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
