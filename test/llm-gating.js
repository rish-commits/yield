// STAGES 2 & 3 — generation, gating, caching, and the two distinct fallbacks.
//
// Runs against the COMPILED build with a STUB standing in for the CLI, so every
// path is deterministic and free. Stage 4 uses the real model for tone; this
// file is about when a call happens at all, and what happens when it doesn't.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'stub-claude.sh');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-llm-'));
const MODE = path.join(WS, 'mode');
const CALLS = path.join(WS, 'calls');

process.env.YIELD_CLAUDE_BIN = STUB;
process.env.YIELD_STUB_MODE = MODE;
process.env.YIELD_STUB_CALLS = CALLS;
fs.writeFileSync(MODE, 'ok');
fs.writeFileSync(CALLS, '');

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setMode = (m) => fs.writeFileSync(MODE, m);
// one line per invocation — the prompt argument itself contains newlines
const callCount = () => fs.readFileSync(CALLS, 'utf8').split('\n').filter((l) => l.startsWith('CALL ')).length;
/** Saving a note is engagement; without it the gate correctly mutes partway
 *  through and later sections would be testing the wrong thing. */
const engage = () => onMsg({ type: 'engaged' });
const resetCalls = () => fs.writeFileSync(CALLS, '');

fs.mkdirSync(path.join(WS, '.yield'));
fs.writeFileSync(path.join(WS, '.yield', 'yield-context.md'),
  '# Project context\n\n## Notes\n\n- deploy target is Vercel\n');

const posted = [];
const logged = [];
let onMsg = null;
let hookHandler = null;
let panelAlive = false;

const vscodeStub = {
  Uri: {
    joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString: () => 'r:' + path.join(b.fsPath, ...p) }),
    file: (f) => ({ fsPath: f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: { workspaceFolders: [{ uri: { fsPath: WS } }], openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
    createWebviewPanel: () => {
      panelAlive = true;
      const p = {
        webview: {
          cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
          set html(v) { this._h = v; }, get html() { return this._h; },
          postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (cb) => { onMsg = cb; return { dispose() {} }; }
        },
        reveal() {},
        dispose() { panelAlive = false; if (p._onDispose) { p._onDispose(); } },
        onDidDispose: (cb) => { p._onDispose = cb; return { dispose() {} }; },
        viewColumn: 1
      };
      return p;
    },
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd, uri, opts) => { vscodeStub._executed.push({ cmd, uri, opts }); }
  },
  _executed: [], _cmds: {}
};

const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') { return vscodeStub; }
  if (req === 'http') {
    return { createServer: (h) => { hookHandler = h; return { on() {}, listen: (p, ho, cb) => cb && cb(), close() {} }; } };
  }
  return realLoad.apply(this, arguments);
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));

function hook(payload) {
  return new Promise((resolve) => {
    const L = {};
    hookHandler({ method: 'POST', on: (e, c) => { L[e] = c; } }, { writeHead() {}, end: (b) => resolve(b) });
    L.data(Buffer.from(JSON.stringify(payload)));
    L.end();
  });
}
const lastRender = () => posted.filter((m) => m.type === 'render').pop();
const shownQuestions = () => (lastRender()?.questions || []).map((q) => `${q.id}:${q.text}`);
const firstShown = () => shownQuestions()[0] || '';
const openPanel = async () => { await vscodeStub._cmds['yield.open'](); onMsg({ type: 'ready' }); await wait(60); };

(async () => {
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(WS, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  await wait(100);

  console.log('=== 0. the ask module, in isolation ===');
  const A = require(path.join(ROOT, 'out', 'ask.js'));
  check('NONE means silence, not failure', A.parseAsk('NONE').kind, 'silent');
  check('trailing punctuation still means silence', A.parseAsk('NONE.').kind, 'silent');
  check('empty output means silence', A.parseAsk('   ').kind, 'silent');
  check('a line is a question', A.parseAsk('Could add how migrations run, or anything else.').kind, 'question');
  check('surrounding quotes are stripped',
    A.parseAsk('"Could add how migrations run."').text, 'Could add how migrations run.');
  check('a stray preamble line is discarded',
    A.parseAsk('Here you go:\nCould add how migrations run.').text, 'Could add how migrations run.');
  const pairs = new Set();
  for (let i = 0; i < 16; i++) { const p2 = A.nextPhrasing(); pairs.add(p2.opening + '|' + p2.ending); }
  check('16 distinct opening/ending pairings before repeating', pairs.size, 16);
  check('every opening is an offer, never an instruction',
    A.OPENINGS.every((o) => !/^You should/i.test(o)), true);
  check('every ending keeps the door open',
    A.ENDINGS.every((e) => /\bor\b/.test(e)), true);
  const sys = A.buildSystemPrompt('Worth mentioning', 'or something else entirely');
  check('the chosen opening is in the prompt', sys.includes('Worth mentioning'), true);
  check('the chosen ending is in the prompt', sys.includes('or something else entirely'), true);
  check('parentheses are banned', /No parentheses/.test(sys), true);
  check('the word cap is stated as hard', /HARD LIMIT: 15 words/.test(sys), true);
  check('NONE is offered as a first-class outcome', /output exactly NONE/.test(sys), true);

  console.log('\n=== 1. gating: no call is made when it could not be shown ===');
  resetCalls();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add rate limiting', cwd: WS });
  await wait(400);
  check('panel CLOSED -> zero model calls', callCount(), 0);
  check('and it says why', logged.some((l) => /no question generated: panel closed/.test(l)), true);

  await openPanel();
  resetCalls();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add rate limiting to the api', cwd: WS });
  await wait(600);
  check('panel OPEN -> exactly one model call', callCount(), 1);
  report('question shown', JSON.stringify(shownQuestions()));
  check('the generated question is shown', shownQuestions().length, 1);
  check('and it is the model\'s, not the script\'s', firstShown().startsWith('llm:'), true);

  console.log('\n=== 2. the sentinel and neutral cwd are actually used ===');
  const args = fs.readFileSync(CALLS, 'utf8');
  check('the prompt carries the sentinel', args.includes('[yield-internal-generation]'), true);
  check('haiku was requested', args.includes('--model haiku'), true);
  check('tools were denied', args.includes('--disallowedTools'), true);
  check('one turn only', args.includes('--max-turns 1'), true);

  console.log('\n=== 3. the cache ===');
  resetCalls();
  const before = shownQuestions()[0];
  // close and reopen WITHIN the same run: the question must survive
  ext.deactivate === undefined;
  onMsg({ type: 'close' });
  await wait(50);
  await openPanel();
  await wait(100);
  check('the question survives panel close/reopen', shownQuestions()[0], before);
  check('and cost no extra model call', callCount(), 0);

  resetCalls();
  engage();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'a completely different task about caching', cwd: WS });
  await wait(600);
  check('a NEW task invalidates and regenerates', callCount(), 1);

  console.log('\n=== 4. FALLBACK A — model unavailable -> the SCRIPTED question ===');
  setMode('fail');
  resetCalls();
  engage();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add authentication to the api', cwd: WS });
  await wait(800);
  report('shown', JSON.stringify(shownQuestions()));
  check('a call was attempted', callCount(), 1);
  check('something is still shown', shownQuestions().length >= 1, true);
  check('it is the SCRIPTED question, not the model\'s', firstShown().startsWith('llm:'), false);
  check('the failure is logged, not surfaced', logged.some((l) => /falling back to the scripted one/.test(l)), true);

  console.log('\n    ...and unauthenticated behaves the same way, silently');
  setMode('auth');
  engage();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add authentication to the api again', cwd: WS });
  await wait(800);
  check('still shows the scripted question', firstShown().startsWith('llm:'), false);
  check('nobody is asked to log in',
    logged.some((l) => /\/login/i.test(l) && !/falling back/.test(l)) ||
    posted.some((m) => JSON.stringify(m).includes('login')), false);

  console.log('\n=== 5. FALLBACK B — model chose silence -> show NOTHING ===');
  setMode('none');
  engage();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'rename a variable in utils.ts', cwd: WS });
  await wait(800);
  report('shown', JSON.stringify(shownQuestions()));
  check('NOTHING is shown', shownQuestions(), []);
  check('and it is recorded as a choice, not a failure',
    logged.some((l) => /nothing worth asking — staying quiet/.test(l)), true);
  check('the scripted question did NOT paper over it', shownQuestions().length, 0);

  console.log('\n=== 6. the timeout really kills a hung call ===');
  setMode('hang');
  const t0 = Date.now();
  engage();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'set up CI for the monorepo', cwd: WS });
  // the stub sleeps 60s; the guard must fire long before that
  let waited = 0;
  while (waited < 12000 && !logged.some((l) => /timed out/.test(l))) { await wait(150); waited += 150; }
  const elapsed = Date.now() - t0;
  report('gave up after', `${(elapsed / 1000).toFixed(1)}s (stub would have hung for 60s)`);
  check('it timed out rather than hanging', logged.some((l) => /timed out after 4500ms/.test(l)), true);
  check('well inside the stub\'s 60s hang', elapsed < 12000, true);
  check('and fell back to the script', firstShown().startsWith('llm:'), false);

  console.log('\n=== 7. a muted user costs nothing ===');
  setMode('ok');
  // three consecutive rounds where questions were offered and ignored
  for (let i = 0; i < 4; i++) {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: `ignored task ${i} about deploying`, cwd: WS });
    await wait(500);
  }
  check('the gate muted after repeated silence', logged.some((l) => /questions muted/.test(l)), true);
  resetCalls();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'yet another task about deploying', cwd: WS });
  await wait(500);
  check('MUTED -> zero model calls', callCount(), 0);
  check('and it says why', logged.some((l) => /no question generated: questions muted/.test(l)), true);
  check('nothing is shown either', shownQuestions(), []);

  // ============================================ how the CLI is launched per platform
  //
  // The Windows defect: CreateProcess cannot run a .cmd, and the npm install of
  // Claude Code IS `claude.cmd`, so spawn('claude') ENOENTed and smart
  // suggestions silently fell back forever. Windows cannot be run here, so what
  // is proven is the COMMAND LINE, deterministically, on every platform.
  console.log('\n=== 6. launchSpec: what actually gets spawned ===');
  const ASK = require(path.join(ROOT, 'out', 'ask.js'));
  const ARGS = ['-p', 'hello', '--model', 'haiku'];

  const posix = ASK.launchSpec('/usr/local/bin/claude', ARGS, 'darwin');
  check('posix: spawns the binary directly', posix.file, '/usr/local/bin/claude');
  check('posix: args are untouched', posix.args, ARGS);
  check('posix: no verbatim quoting', posix.verbatim, false);
  check('linux behaves identically', ASK.launchSpec('/home/me/.local/bin/claude', ARGS, 'linux').file,
    '/home/me/.local/bin/claude');

  const exe = ASK.launchSpec('C:\\Program Files\\claude\\claude.exe', ARGS, 'win32');
  check('win .exe: still spawned DIRECTLY, no shell', exe.file, 'C:\\Program Files\\claude\\claude.exe');
  check('win .exe: args untouched', exe.args, ARGS);
  check('win .exe: not verbatim', exe.verbatim, false);

  const cmd = ASK.launchSpec('C:\\Users\\me\\AppData\\npm\\claude.cmd', ARGS, 'win32');
  check('win .cmd: routed through the command processor',
    /cmd\.exe$|^cmd\.exe$/.test(cmd.file) || cmd.file === process.env.ComSpec, true);
  check('win .cmd: uses /d /s /c', cmd.args.slice(0, 3), ['/d', '/s', '/c']);
  check('win .cmd: verbatim, so node does not re-quote', cmd.verbatim, true);
  check('win .cmd: the shim path is in the line', /claude\.cmd/.test(cmd.args[3]), true);
  check('win .bat is treated the same', ASK.launchSpec('c:\\x\\claude.bat', ARGS, 'win32').verbatim, true);
  check('case-insensitive extension match', ASK.launchSpec('c:\\x\\CLAUDE.CMD', ARGS, 'win32').verbatim, true);

  // THE REASON THIS IS NOT `shell: true`. The prompt is arbitrary user text and
  // carries the whole context file, so anything cmd.exe treats as syntax has to
  // be neutralised or a note becomes a command.
  const nasty = ['-p', 'note & calc.exe | echo "pwned" > out.txt %PATH% ^ (x)'];
  const esc = ASK.launchSpec('c:\\x\\claude.cmd', nasty, 'win32').args[3];
  for (const ch of ['&', '|', '>', '%', '^', '(', ')']) {
    check(`cmd metachar ${ch} is carets-escaped`, esc.includes('^' + ch), true);
  }
  check('no bare & survives', / & /.test(esc), false);
  check('an embedded quote is escaped, not left to close the string',
    ASK.launchSpec('c:\\x\\claude.cmd', ['-p', 'say "hi"'], 'win32').args[3].includes('\\^"'), true);

  // ================================ the follow-up responds to the NOTE (v1.7.0)
  console.log('\n=== 7. follow-up is about what they just wrote ===');
  const M = ASK.looksLikeMash;

  // Real mash from the live context file.
  for (const t of ['jhvvv', 'jhgcfdsdxfg', 'khbhb', 'glrtkht', 'fjdnvr', 'dfcgvhj']) {
    check(`mash suppressed: ${t}`, M(t), true);
  }
  // THE EXPENSIVE MISTAKE IS THE OTHER DIRECTION. A wrong verdict here silences
  // a real note, so these are the checks that actually matter.
  for (const t of ['idk', 'hey', 'npm', 'pnpm', 'TS', 'CI', 'HTTPS', 'SMTP', 'rhythm',
    'myths', 'crypt', 'glyph', 'sync', 'gRPC', 'CSRF', 'TypeScript', 'node_modules',
    'src/components/Button.tsx', 'we use supabase for auth', 'always use tabs, never spaces']) {
    check(`real note survives: ${t}`, M(t), false);
  }
  check('a space anywhere means real', M('khbhb khbhb'), false);
  check('under five characters is never mash', M('fjf'), false);

  // The note reaches the model, labelled as the thing to respond to.
  const up = ASK.buildUserPrompt('some task', '# ctx', 'we use supabase for auth');
  check('the note is in the user prompt', up.includes('we use supabase for auth'), true);
  check('and it is labelled as the thing to answer', /RESPOND TO THIS/.test(up), true);
  check('the note comes AFTER the task, so it reads last',
    up.indexOf('we use supabase for auth') > up.indexOf('some task'), true);
  check('no note means no note block',
    /RESPOND TO THIS/.test(ASK.buildUserPrompt('some task', '# ctx')), false);

  const sysNote = ASK.buildSystemPrompt('Could add', 'or anything else', 'note');
  const sysTask = ASK.buildSystemPrompt('Could add', 'or anything else', 'task');
  check('note mode tells it to go deeper', /GO DEEPER ON WHAT THEY JUST WROTE/.test(sysNote), true);
  check('task mode does not', /GO DEEPER/.test(sysTask), false);
  check('task mode is the default', ASK.buildSystemPrompt('Could add', 'or anything else'), sysTask);
  for (const shared of ['THE LINE HAS EXACTLY THREE PARTS', 'HARD LIMIT: 15 words',
    'No parentheses', 'At most ONE hedge']) {
    check(`tone rule is shared by both modes: ${shared.slice(0, 28)}`,
      sysNote.includes(shared) && sysTask.includes(shared), true);
  }

  // GATE BEFORE SPAWNING: mash must cost zero model calls, not a discarded one.
  resetCalls();
  const mashAsk = await ASK.generateQuestion({ task: 'a real task', store: '# ctx', note: 'khbhb', cwd: os.tmpdir() });
  check('mash returns silent', mashAsk.kind, 'silent');
  check('and spawns NOTHING', callCount(), 0);
  resetCalls();
  const realAsk = await ASK.generateQuestion({ task: 'a real task', store: '# ctx', note: 'we use supabase for auth', cwd: os.tmpdir() });
  check('a real note does spawn', callCount(), 1);
  check('and comes back as a question', realAsk.kind, 'question');

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
