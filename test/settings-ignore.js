// The smart-suggestions setting and gitignore handling, against the COMPILED
// build. The delicate one is the gitignore rule: removing the line is how a
// team opts into sharing, so it must never come back.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const I = require(path.join(ROOT, 'out', 'ignore.js'));
const STUB = path.join(__dirname, 'stub-claude.sh');

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yield-si-'));
const gitRepo = () => { const w = ws(); fs.mkdirSync(path.join(w, '.git')); return w; };

// ─────────────────────────────────────────────── the compiled extension

const WS = gitRepo();
const MODE = path.join(WS, 'mode');
const CALLS = path.join(WS, 'calls');
process.env.YIELD_CLAUDE_BIN = STUB;
process.env.YIELD_STUB_MODE = MODE;
process.env.YIELD_STUB_CALLS = CALLS;
fs.writeFileSync(MODE, 'ok');
fs.writeFileSync(CALLS, '');
const callCount = () => fs.readFileSync(CALLS, 'utf8').split('\n').filter((l) => l.startsWith('CALL ')).length;
const resetCalls = () => fs.writeFileSync(CALLS, '');

const posted = [];
const logged = [];
let onMsg = null;
let hookHandler = null;
let smart = true;                     // what the setting currently says
let configListener = null;
const workspaceStore = new Map();

const vscodeStub = {
  Uri: {
    joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString: () => 'r:' + path.join(b.fsPath, ...p) }),
    file: (f) => ({ fsPath: f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WS } }],
    openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (key, dflt) => (key === 'smartSuggestions' ? smart : dflt) }),
    onDidChangeConfiguration: (cb) => { configListener = cb; return { dispose() {} }; }
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
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {},
    showInformationMessage() {}
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async () => {}
  },
  _cmds: {}
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
const shown = () => (lastRender()?.questions || []).map((q) => `${q.id}:${q.text}`);
const setSmart = async (v) => {
  smart = v;
  if (configListener) { configListener({ affectsConfiguration: (k) => k === 'yield.smartSuggestions' }); }
  await wait(500);
};

(async () => {
  console.log('=== 1. gitignore, in isolation ===');
  let w = gitRepo();
  let r = await I.ensureIgnored(w, false);
  check('added to a fresh repo', r.state, 'added');
  const written = fs.readFileSync(path.join(w, '.gitignore'), 'utf8');
  report('file written', JSON.stringify(written));
  check('the entry is there', I.alreadyIgnored(written), true);

  console.log('\n=== 2. an existing .gitignore survives ===');
  w = gitRepo();
  const theirs = 'node_modules\n*.log\n\n# build\ndist/\n';
  fs.writeFileSync(path.join(w, '.gitignore'), theirs);
  await I.ensureIgnored(w, false);
  const after = fs.readFileSync(path.join(w, '.gitignore'), 'utf8');
  check('every original byte is still there', after.startsWith(theirs), true);
  check('and ours was appended', I.alreadyIgnored(after), true);
  report('result', JSON.stringify(after));

  // a file with no trailing newline must not have our entry glued to its last line
  w = gitRepo();
  fs.writeFileSync(path.join(w, '.gitignore'), 'node_modules');
  await I.ensureIgnored(w, false);
  const glued = fs.readFileSync(path.join(w, '.gitignore'), 'utf8');
  check('no missing-newline mangling', glued.split('\n')[0], 'node_modules');
  check('and ours is on its own line', glued.split('\n').includes('.yield/'), true);

  console.log('\n=== 3. THE RULE: removing it is a decision we never override ===');
  w = gitRepo();
  await I.ensureIgnored(w, false);                       // first run writes it
  fs.writeFileSync(path.join(w, '.gitignore'), 'node_modules\n');   // user deletes our line
  r = await I.ensureIgnored(w, true);                    // every later run
  check('we do NOT add it back', r.state, 'already-done');
  check('the file is left as they wrote it',
    fs.readFileSync(path.join(w, '.gitignore'), 'utf8'), 'node_modules\n');
  r = await I.ensureIgnored(w, true);
  check('still not, however many times we run', I.alreadyIgnored(fs.readFileSync(path.join(w, '.gitignore'), 'utf8')), false);

  console.log('\n=== 4. never twice, and not a repo means nothing ===');
  w = gitRepo();
  await I.ensureIgnored(w, false);
  r = await I.ensureIgnored(w, false);   // pretend we forgot; the file still says it
  check('a second write is recognised as already present', r.state, 'already-present');
  const twice = fs.readFileSync(path.join(w, '.gitignore'), 'utf8');
  check('exactly one entry', twice.split('\n').filter((l) => l.trim() === '.yield/').length, 1);

  const plain = ws();   // no .git
  r = await I.ensureIgnored(plain, false);
  check('a non-git folder is left completely alone', r.state, 'not-a-repo');
  check('and no .gitignore was created', fs.existsSync(path.join(plain, '.gitignore')), false);

  console.log('\n=== 5. through the compiled extension ===');
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(WS, 'gs') },
    subscriptions: [],
    workspaceState: { get: (k, d) => (workspaceStore.has(k) ? workspaceStore.get(k) : d), update: async (k, v) => { workspaceStore.set(k, v); } },
    extension: { packageJSON: { version: 'test' } }
  });
  await wait(500);
  check('the entry was written on activation',
    I.alreadyIgnored(fs.readFileSync(path.join(WS, '.gitignore'), 'utf8')), true);
  check('and remembered, so it never repeats', workspaceStore.get('yield.gitignoreWritten'), true);
  check('silently — nothing in the panel', (lastRender()?.setupNote) || '', '');

  // remove it by hand, then do the things that would re-trigger setup
  fs.writeFileSync(path.join(WS, '.gitignore'), '# mine only\n');
  await vscodeStub._cmds['yield.open']();
  onMsg({ type: 'ready' });
  onMsg({ type: 'note', text: 'a note saved after removing the line' });
  await wait(400);
  check('saving a note does not bring it back',
    fs.readFileSync(path.join(WS, '.gitignore'), 'utf8'), '# mine only\n');

  console.log('\n=== 6. smart suggestions ON ===');
  await setSmart(true);
  resetCalls();
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add rate limiting to the api', cwd: WS });
  await wait(600);
  check('a model call is made', callCount(), 1);
  report('question', JSON.stringify(shown()));
  check('and the generated question is shown', shown()[0].startsWith('llm:'), true);

  console.log('\n=== 7. smart suggestions OFF: no spawn, ever ===');
  await setSmart(false);
  check('the panel swapped to the scripted question with no reload',
    (shown()[0] || '').startsWith('llm:'), false);
  report('question now', JSON.stringify(shown()));
  check('a scripted question IS shown, not nothing', shown().length >= 1, true);

  resetCalls();
  onMsg({ type: 'engaged' });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'set up CI for the monorepo', cwd: WS });
  await wait(700);
  check('ZERO model calls', callCount(), 0);
  check('and it says why', logged.some((l) => /smart suggestions are off/.test(l)), true);
  check('the scripted question still works', shown().length >= 1, true);
  check('nothing looks like an error', logged.some((l) => /FAIL|error|Error/.test(l)), false);

  // saving a note must not spawn either
  resetCalls();
  onMsg({ type: 'note', text: 'a note with the setting off' });
  await wait(700);
  check('saving a note spawns nothing either', callCount(), 0);
  check('but the note still saved',
    fs.readFileSync(path.join(WS, '.yield', 'yield-context.md'), 'utf8').includes('a note with the setting off'), true);
  check('and the scripted acknowledgment still lands',
    posted.filter((m) => m.type === 'reply').length > 0, true);

  console.log('\n=== 8. back ON at runtime ===');
  await setSmart(true);
  resetCalls();
  onMsg({ type: 'engaged' });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add caching to the product listing', cwd: WS });
  await wait(700);
  check('calls resume with no reload', callCount(), 1);
  check('and the generated question is back', shown()[0].startsWith('llm:'), true);

  fs.rmSync(WS, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
