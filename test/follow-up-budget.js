// THE FOLLOW-UP BUDGET IS PER NOTE (v1.9.0) — and what still stops it.
//
// The cap used to be two per WAIT, reset only on UserPromptSubmit, which meant
// a long turn with a dozen notes answered the first two and went silent. This
// suite proves the new rule and, harder, proves the thing that actually
// protects the user did not move: the gate.
//
// Its own file with its own extension instance, because llm-gating mutes the
// gate partway through and everything after would inherit that.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'stub-claude.sh');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-budget-'));
const MODE = path.join(WS, 'mode');
const CALLS = path.join(WS, 'calls');
process.env.YIELD_CLAUDE_BIN = STUB;
process.env.YIELD_STUB_MODE = MODE;
process.env.YIELD_STUB_CALLS = CALLS;
fs.writeFileSync(MODE, 'ok');
fs.writeFileSync(CALLS, '');
fs.mkdirSync(path.join(WS, '.yield'));
fs.writeFileSync(path.join(WS, '.yield', 'yield-context.md'),
  '# Project context\n\n## Notes\n\n- deploy target is Vercel\n');

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const callCount = () => fs.readFileSync(CALLS, 'utf8').split('\n').filter((l) => l.startsWith('CALL ')).length;
const resetCalls = () => fs.writeFileSync(CALLS, '');

const posted = [];
const logged = [];
let onMsg = null;
let hookHandler = null;

const vscodeStub = {
  Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString: () => 'r:' + path.join(b.fsPath, ...p) }), file: (f) => ({ fsPath: f }) },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WS } }], openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({ dispose() {} })
  },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
        set html(v) { this._h = v; }, get html() { return this._h; },
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (cb) => { onMsg = cb; return { dispose() {} }; }
      },
      reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), viewColumn: 1
    }),
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}
  },
  commands: { registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  _cmds: {}
};
const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') { return vscodeStub; }
  if (req === 'http') {
    return { createServer: (h) => { hookHandler = h; return { on() {}, listen: (p, ho, cb) => cb && cb(), close() {}, listening: true }; } };
  }
  return realLoad.apply(this, arguments);
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));
const G = require(path.join(ROOT, 'out', 'gate.js'));
const ASK = require(path.join(ROOT, 'out', 'ask.js'));

function hook(payload) {
  return new Promise((resolve) => {
    const L = {};
    hookHandler({ method: 'POST', on: (e, c) => { L[e] = c; } }, { writeHead() {}, end: (b) => resolve(b) });
    L.data(Buffer.from(JSON.stringify(payload)));
    L.end();
  });
}
const suggested = () => posted.filter((m) => m.type === 'suggest').length;

(async () => {
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(WS, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  await wait(120);
  await vscodeStub._cmds['yield.open']();
  onMsg({ type: 'ready' });
  await wait(80);

  // MUST run before any hook: this is the state a brand new user is in.
  console.log('=== 0. a note with NO task yet — the first thing a new user does ===');
  resetCalls(); posted.length = 0; logged.length = 0;
  onMsg({ type: 'note', text: 'we use supabase for auth' });
  await wait(900);
  check('a note with no task still gets its follow-up', suggested(), 1);
  check('and it did spawn the model', callCount(), 1);
  check('it is NOT refused for having no task',
    logged.some((l) => /no follow-up: no task yet/.test(l)), false);

  // Moment A is unchanged. It has only the task to key off, so an empty task
  // with NO note stays silent — relaxing that would be inventing a subject.
  const taskModeEmpty = await ASK.generateQuestion({ task: '', store: '# ctx', cwd: os.tmpdir() });
  check('task mode with no task is still silent', taskModeEmpty.kind, 'silent');
  check('task mode with a task still asks',
    (await ASK.generateQuestion({ task: 'add a migration', store: '# ctx', cwd: os.tmpdir() })).kind, 'question');

  // Neither a task nor a note is still silence, not a generic line.
  const neither = await ASK.generateQuestion({ task: '', store: '# ctx', cwd: os.tmpdir() });
  check('no task AND no note stays silent', neither.kind, 'silent');
  check('an empty task is labelled for the model, not left blank',
    /nothing yet/.test(ASK.buildUserPrompt('', '# ctx', 'a note')), true);
  check('a real task is still passed through verbatim',
    ASK.buildUserPrompt('refactor auth', '# ctx', 'a note').includes('refactor auth'), true);

  console.log('\n=== 1. MANY notes inside ONE wait — the case that used to go silent ===');
  await hook({ hook_event_name: 'UserPromptSubmit', cwd: WS, prompt: 'refactor the auth middleware' });
  await wait(500);
  resetCalls(); posted.length = 0;
  for (let n = 1; n <= 6; n++) {
    const before = suggested();
    onMsg({ type: 'note', text: `note ${n}: sessions live in redis with a 30 day ttl` });
    await wait(700);
    check(`note ${n} still gets its follow-up`, suggested() - before, 1);
  }
  check('six notes, six suggestions — not two', suggested(), 6);
  check('one model call per note', callCount(), 6);
  check('nothing was refused as a chain',
    logged.some((l) => /already suggested twice this wait/.test(l)), false);

  console.log('\n=== 2. NEVER twice about a single note ===');
  const s0 = suggested(); const c0 = callCount();
  onMsg({ type: 'note', text: 'a note that must be answered exactly once' });
  await wait(800);
  check('exactly one suggestion for that note', suggested() - s0, 1);
  check('exactly one model call for that note', callCount() - c0, 1);

  console.log('\n=== 3. THE SAFETY RULE — offered and ignored still mutes ===');
  let g = G.makeQuestionGate(3);
  g.offer(); check('one ignored round does not mute', g.closeRound(), false);
  g.offer(); check('two ignored rounds do not mute', g.closeRound(), false);
  g.offer(); check('THREE ignored rounds MUTE', g.closeRound(), true);
  check('and it stays muted for the session', g.muted, true);

  g = G.makeQuestionGate(3);
  g.offer(); g.closeRound();
  g.offer(); g.engage(); g.closeRound();
  g.offer();
  check('any engagement resets the counter', g.closeRound(), false);

  g = G.makeQuestionGate(3);
  g.closeRound(); g.closeRound(); g.closeRound(); g.closeRound();
  check('rounds that offered nothing never count as ignored', g.muted, false);

  console.log('\n=== 4. once muted, the compiled build spawns NOTHING ===');
  // Drive the real thing to muted: offer rows and give total silence. A fresh
  // panel state is needed, so the rows are offered by a task with no notes yet.
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-mute-'));
  fs.mkdirSync(path.join(WS2, '.yield'));
  fs.writeFileSync(path.join(WS2, '.yield', 'yield-context.md'), '# Project context\n');
  vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: WS2 } }];

  resetCalls(); logged.length = 0; posted.length = 0;
  for (let r = 1; r <= 4; r++) {
    await hook({ hook_event_name: 'UserPromptSubmit', cwd: WS2, prompt: `round ${r}: add a migration for the users table` });
    await wait(600);
  }
  const mutedNow = logged.some((l) => /questions muted for this session/.test(l));
  check('total silence across rounds mutes the live build', mutedNow, true);

  resetCalls(); posted.length = 0;
  onMsg({ type: 'note', text: 'a real note written after the gate closed' });
  await wait(800);
  check('a muted panel spawns ZERO model calls', callCount(), 0);
  check('and says why, rather than going quiet without a reason',
    logged.some((l) => /no follow-up: questions muted/.test(l)), true);
  check('and shows no suggestion', suggested(), 0);

  console.log('\n=== 5. WHAT THE BACK-OFF DOES NOT COVER (documented, not a bug) ===');
  // Saving a note calls gate.engage() (extension.ts, the `note` message), and
  // gate.ts says so in its own comment: "they clicked a question or saved a
  // note — either way, they engaged". So somebody who writes notes constantly
  // while ignoring every suggestion is NEVER muted: they are, by this
  // definition, engaged. Asserted here so the property is known and visible
  // rather than discovered later.
  let gb = G.makeQuestionGate(3);
  for (let r = 1; r <= 8; r++) { gb.offer(); gb.engage(); gb.closeRound(); }
  check('a note-writer who ignores suggestions is NOT muted', gb.muted, false);
  check('and their ignored-round count never rises', gb.ignoredRounds, 0);
  // Which means the only bound on follow-ups for an ACTIVE note-writer is the
  // one-per-note guard proved in sections 1 and 2 — deliberate, because every
  // one of those notes is user-initiated.

  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(WS2, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
