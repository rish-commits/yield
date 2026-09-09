// LLM-generated questions, via the user's own already-authenticated Claude Code
// CLI spawned headless. No API key, no signup, no new dependency — and Yield
// never sees a credential.
//
// Free of any `vscode` import, like gate.ts / questions.ts / ports.ts /
// store.ts, so the rules can be tested directly.
//
// ── THE LOOP, AND THE TWO THINGS THAT PREVENT IT ────────────────────────────
// Yield's own UserPromptSubmit hook fires for ANY `claude -p` started inside the
// project, so a naive call means Yield triggering Yield. Measured in the spike:
// project cwd fired the hook every time and flickered the panel's chip.
//
//   1. NEUTRAL CWD — the real prevention. Claude Code loads hooks from the cwd's
//      .claude/settings.json, so running from a directory outside any project
//      loads none. Verified: 0 hook fires across repeated runs, vs 1/1 from the
//      project. `--settings` pointing at an empty file does NOT work; project
//      hooks still load.
//
//   2. THE SENTINEL — the belt to that pair of braces. Neutral cwd is only
//      sufficient because there are no hooks in ~/.claude/settings.json today.
//      The day a global hook appears, it fires from every cwd and the loop comes
//      back SILENTLY. The sentinel rides in the prompt, which the hook payload
//      carries, so Yield can recognise its own call and ignore it. Costs
//      nothing, and turns that future breakage into a no-op.
//
// `--strict-mcp-config` is kept as cheap insurance but is NOT load-bearing:
// measured 20,982 tokens without it vs 20,728 with, i.e. no difference. The
// account's MCP servers never load into a headless call.

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Marks a call Yield made itself. Must survive into the hook payload's `prompt`. */
export const SENTINEL = '[yield-internal-generation]';

/** Hard kill. Network failures do NOT fail fast — connection-refused hung past
 *  45s in the spike — so the timeout is ours, not the CLI's. Median call is
 *  ~2.9s, so this leaves headroom without stalling a reply. */
export const TIMEOUT_MS = 4500;

export const MODEL = 'haiku';

/** Tools are denied rather than hidden, so the model can still *try* one and
 *  burn its single turn. The prompt framing is what stops it; this is defence. */
const DENIED = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit'];

export type Ask =
  /** a question worth showing */
  | { kind: 'question'; text: string }
  /** the model looked and decided there is nothing worth asking — a FEATURE */
  | { kind: 'silent' }
  /** the model was not reachable. Caller falls back to the scripted question. */
  | { kind: 'failed'; reason: string };

/** True when a hook payload is Yield's own generation call coming back at us. */
export function isOwnCall(prompt: unknown): boolean {
  return typeof prompt === 'string' && prompt.includes(SENTINEL);
}

/**
 * A directory with no CLAUDE.md and no .claude/, so a spawned call inherits no
 * project configuration and fires no project hooks. Lives in the extension's
 * global storage — outside every workspace by construction.
 */
export async function neutralCwd(globalStorageDir: string): Promise<string> {
  const dir = path.join(globalStorageDir, 'spawn');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * The environment for the spawned call.
 *
 * Every CLAUDE_* variable is stripped. The extension host has none of them, so
 * in production this is a no-op — but it makes the call behave identically when
 * spawned from a shell that IS inside Claude Code (which is how it gets tested),
 * and removes any chance of session state leaking into a nested run.
 * ANTHROPIC_* is left alone: that is legitimate user configuration.
 */
export function spawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (/^CLAUDE/i.test(k)) { continue; }
    env[k] = v;
  }
  env.MAX_THINKING_TOKENS = '0';   // the single biggest latency win: 30s -> 3s
  return env;
}

export type GenerateOptions = {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  timeoutMs?: number;
  /** injectable so tests can point at a stub instead of the real CLI */
  binary?: string;
  env?: NodeJS.ProcessEnv;
};

/** Quote one argument the way CommandLineToArgvW will read it back out. */
function winQuote(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
}

/** ...then caret what cmd.exe would otherwise treat as syntax rather than text. */
function cmdEscape(arg: string): string {
  return winQuote(arg).replace(/[()%!^"<>&|]/g, '^$&');
}

/**
 * How to launch a resolved CLI path on this platform.
 *
 * CreateProcess CANNOT execute a .cmd/.bat, and the npm install of Claude Code
 * on Windows is exactly that — a `claude.cmd` shim. That is the whole reason a
 * bare `spawn('claude')` fails there. A shim has to go through cmd.exe, but
 * `shell: true` would hand cmd.exe a line containing the PROMPT — raw user
 * text plus the entire context file — so one `&` or `"` in someone's note
 * would become a command. Instead every argument is escaped for both
 * CommandLineToArgvW and cmd.exe, and passed verbatim so Node does not quote
 * it a second time.
 *
 * Everything else is spawned directly with no shell at all: every POSIX
 * binary, and `claude.exe` on Windows. That path is unchanged.
 */
export function launchSpec(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { file: string; args: string[]; verbatim: boolean } {
  const isShim = platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  if (!isShim) { return { file: bin, args, verbatim: false }; }
  const line = [bin, ...args].map(cmdEscape).join(' ');
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatim: true
  };
}

/**
 * One model call. Returns the raw text, or a failure — the caller decides what
 * `NONE` means, because "nothing to ask" and "could not ask" are different
 * outcomes with different handling.
 */
export function runClaude(opts: GenerateOptions): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const args = [
      '-p', `${SENTINEL}\n${opts.userPrompt}`,
      '--model', MODEL,
      '--system-prompt', opts.systemPrompt,
      '--disallowedTools', ...DENIED,
      '--max-turns', '1',
      '--output-format', 'json',
      '--strict-mcp-config'
    ];

    let child;
    try {
      // YIELD_CLAUDE_BIN lets someone point at a CLI that is not on PATH, and
      // is the seam the tests use to stand in a stub for the real thing. It
      // OUTRANKS opts.binary: that one is whatever findClaude() detected, and
      // an explicit override the user set must beat auto-detection, not lose
      // to it.
      const bin = process.env.YIELD_CLAUDE_BIN ?? opts.binary ?? 'claude';
      const spec = launchSpec(bin, args);
      child = spawn(spec.file, spec.args, {
        cwd: opts.cwd,
        env: opts.env ?? spawnEnv(),
        // stdin closed immediately: the CLI otherwise waits 3s for input that
        // never comes, which was pure dead time in the spike.
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: spec.verbatim
      });
    } catch (err) {
      resolve({ ok: false, reason: `could not start: ${(err as Error).message}` });
      return;
    }

    let out = '';
    let err = '';
    let done = false;
    const finish = (r: { ok: true; text: string } | { ok: false; reason: string }) => {
      if (done) { return; }
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');   // SIGTERM is not enough for a hung network call
      finish({ ok: false, reason: `timed out after ${opts.timeoutMs ?? TIMEOUT_MS}ms` });
    }, opts.timeoutMs ?? TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    // ENOENT lands here when the CLI is not installed — 29ms in the spike.
    child.on('error', (e) => finish({ ok: false, reason: `not available: ${e.message}` }));

    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: `exited ${code}: ${err.trim().split('\n').pop() || 'no output'}` });
        return;
      }
      try {
        const parsed = JSON.parse(out);
        // Not-logged-in comes back as a 2xx JSON body with is_error set, and
        // never as an interactive prompt. It is a failure, silently.
        if (parsed.is_error || typeof parsed.result !== 'string') {
          finish({ ok: false, reason: String(parsed.result || parsed.subtype || 'no result') });
          return;
        }
        finish({ ok: true, text: parsed.result.trim() });
      } catch {
        finish({ ok: false, reason: 'unparseable response' });
      }
    });
  });
}

// ─────────────────────────────────────────────────────── the question itself

/**
 * Openings and endings rotate, because ten identical lines are a template with
 * a slot, not a voice. They are chosen HERE rather than left to the model:
 * asking for "variety" gets you drift, whereas rotating a fixed set is
 * deterministic, testable, and keeps every variant an OFFER.
 */
export const OPENINGS = [
  'Could add',
  'Might be worth noting',
  'Worth mentioning',
  'You could note'
];

/** The function is identical every time — the door stays open. A suggestion
 *  that just stops reads as a request. Only the words vary. */
export const ENDINGS = [
  "or anything else that's useful",
  'or whatever else is useful',
  'or anything else worth knowing',
  'or something else entirely'
];

let phrasing = 0;
/**
 * Advances one step per call. The ending uses a stride coprime with the list
 * length, so openings and endings do NOT move in lockstep — otherwise the same
 * four pairings would repeat forever and the "variety" would be four templates
 * instead of one. With 4 and 4 at stride 3 the cycle is 16 distinct pairs.
 */
export function nextPhrasing(): { opening: string; ending: string } {
  const i = phrasing++;
  // The ending advances once per full cycle of openings. A stride within the
  // same modulus would not help: both indices would still be functions of
  // i mod 4, so the PAIR would repeat every 4 regardless.
  return {
    opening: OPENINGS[i % OPENINGS.length],
    ending: ENDINGS[Math.floor(i / OPENINGS.length) % ENDINGS.length]
  };
}

export function buildSystemPrompt(
  opening: string,
  ending: string,
  mode: 'task' | 'note' = 'task'
): string {
  // The ONLY difference between the modes is what the gap must be relevant TO.
  // Everything below it — the three-part shape, the word budget, the bans — is
  // shared, because the tone is locked and a second voice would show.
  const framing = mode === 'note'
    ? [
      'A developer just wrote a note into their project context file. You offer them ONE',
      'line suggesting what would make that note more useful.',
      '',
      'You are given their note, the task they are on, and the current context file.',
      '',
      'GO DEEPER ON WHAT THEY JUST WROTE. The gap you name must be about THAT subject —',
      'the natural next detail someone reading their note would still not know. Do NOT',
      'change the subject to another area of the project, however useful that would be.',
      'Never suggest something their note or the file already says.'
    ]
    : [
      'A developer just sent a task to their coding agent. While it works, you offer them ONE',
      'line suggesting something worth adding to their project context file.',
      '',
      'You are given the task and the current context file.',
      '',
      'Offer a SPECIFIC gap the file does not already cover, relevant to what they are working',
      'on. Never suggest something the file already says.'
    ];
  return [
    ...framing,
    '',
    'THE LINE HAS EXACTLY THREE PARTS:',
    `  1. the words: ${opening}`,
    '  2. a SHORT NOUN PHRASE naming the gap — four to seven words',
    `  3. the words: ${ending}.`,
    '',
    'Part 2 is a noun phrase, never a clause. Do NOT write "that". Do NOT write "should".',
    'Do NOT explain, recommend, or state a fact about any tool.',
    '',
    'Shape, exactly:',
    '  Could add how migrations are handled, or anything else that\'s useful.',
    '  Might be worth noting your preferred test runner, or whatever else is useful.',
    '  Worth mentioning your error tracking service, or anything else worth knowing.',
    '  You could note how secrets are managed, or something else entirely.',
    '',
    'HARD LIMIT: 16 words in the whole line. Count them before answering. Shorter is better.',
    'No parentheses. No lists. No examples of tools. At most ONE hedge such as "if useful".',
    'One line. No quotes, no preamble, no markdown, no bullet.',
    '',
    mode === 'note'
      ? 'If their note already says everything useful about that subject, output exactly NONE.'
      : 'If the file already covers everything relevant to this task, output exactly NONE.'
  ].join('\n');
}

export function buildUserPrompt(task: string, store: string, note?: string): string {
  const lines = [
    'CURRENT CONTEXT FILE:',
    '"""',
    store.trim() || '(empty)',
    '"""',
    '',
    'TASK JUST SENT TO THE AGENT:',
    '"""',
    task.trim() || '(nothing yet — they have not sent the agent a task)',
    '"""'
  ];
  // LAST and labelled loudest: it is the thing being responded to. Placing it
  // above the task invited suggestions about the task instead.
  if (note && note.trim()) {
    lines.push('', 'THE NOTE THEY JUST WROTE — RESPOND TO THIS:', '"""', note.trim(), '"""');
  }
  return lines.join('\n');
}

/**
 * Obvious keyboard mash, and nothing else.
 *
 * DELIBERATELY TOO CAUTIOUS. A wrong "this is gibberish" verdict on a real note
 * is far worse than one unnecessary suggestion, so every rule here is a reason
 * to say NO:
 *  - any whitespace at all -> real. Mash is one blurt.
 *  - under 5 characters -> real, so `idk`, `npm`, `TS`, `CI` can never be mash.
 *  - `y` counts as a vowel, so `rhythm`, `myths`, `crypt` survive.
 *  - ALL CAPS -> real, because `HTTPS` and `SMTP` have no vowels either.
 * What is left is a single lowercase blurt with no vowel in it.
 */
export function looksLikeMash(text: string): boolean {
  const t = text.trim();
  if (!t || /\s/.test(t)) { return false; }
  if (t.length < 5 || t.length > 24) { return false; }
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) { return false; }
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 5) { return false; }
  return !/[aeiouy]/i.test(letters);
}

/**
 * NONE and a failure are DIFFERENT OUTCOMES. `silent` means the model looked and
 * decided there is nothing worth asking — a designed feature that must never be
 * papered over with a canned question. `failed` means it could not be asked, and
 * the caller falls back to the scripted question because there WAS a reason to ask.
 */
export function parseAsk(text: string): Ask {
  const t = text.trim().replace(/^["']|["']$/g, '');
  if (!t || /^NONE[.!]?$/i.test(t)) { return { kind: 'silent' }; }
  // A stray preamble line occasionally appears; keep the last non-empty line.
  const line = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() as string;
  if (/^NONE[.!]?$/i.test(line)) { return { kind: 'silent' }; }
  return { kind: 'question', text: line };
}

export type QuestionRequest = {
  task: string;
  store: string;
  cwd: string;
  /**
   * What the user JUST wrote, when this is the follow-up rather than the
   * opening question. Its presence swaps the whole framing: the suggestion
   * goes deeper on their note instead of prompting about something adjacent.
   */
  note?: string;
  timeoutMs?: number;
  binary?: string;
  env?: NodeJS.ProcessEnv;
};

/** Task + context file in, one offer out. Never throws. */
export async function generateQuestion(req: QuestionRequest): Promise<Ask> {
  const note = (req.note || '').trim();
  // A task is required only when the task IS the subject. With a note there is
  // something concrete to answer, so no task is a normal state rather than a
  // reason to stay quiet — that is the whole after-install dead zone.
  if (!req.task.trim() && !note) { return { kind: 'silent' }; }
  // Obvious keyboard mash is not worth a model call OR a reply. Conservative
  // by design: anything ambiguous goes through as a real note.
  if (note && looksLikeMash(note)) { return { kind: 'silent' }; }
  const { opening, ending } = nextPhrasing();
  const r = await runClaude({
    systemPrompt: buildSystemPrompt(opening, ending, note ? 'note' : 'task'),
    userPrompt: buildUserPrompt(req.task, req.store, note),
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    binary: req.binary,
    env: req.env
  });
  if (!r.ok) { return { kind: 'failed', reason: r.reason }; }
  return parseAsk(r.text);
}
