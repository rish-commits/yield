// The multi-window fix, tested against the COMPILED build.
//
// Part 1 is pure (ports.js). Part 2 uses REAL sockets — the whole point is
// whether a window that loses the port recovers on its own, and you cannot test
// that against a stubbed http module.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'out', 'ports.js'));

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================ 1. pure port rules

console.log('=== 1. per-project ports ===');
const a = P.projectPort('/home/dev/project-a');
const b = P.projectPort('/home/dev/project-b');
report('/home/dev/project-a', a);
report('/home/dev/project-b', b);
check('same path always gives the same port', P.projectPort('/home/dev/project-a'), a);
check('different projects get different ports', a !== b, true);
check('inside the reserved band', a >= P.PORT_BASE && a < P.PORT_BASE + P.PORT_SPAN, true);
check('inside the widened band', [a, b].every((x) => x >= P.PORT_BASE && x < P.PORT_BASE + P.PORT_SPAN), true);
// spread check: 200 paths should not pile onto a handful of ports
const spread = new Set(Array.from({ length: 200 }, (_, i) => P.projectPort(`/home/dev/project-${i}`)));
report('200 distinct paths land on', `${spread.size} of ${P.PORT_SPAN} ports`);
check('paths scatter across the band', spread.size > 150, true);

console.log('\n=== 1b. route-by-cwd across platforms (underRoot) ===');
// The Windows defect this section exists for: Uri.fsPath lower-cases the drive
// letter, the hook's cwd does not, so a byte compare rejected EVERY hook the
// window owned — a panel that looks healthy and is completely deaf.
const WROOT = 'c:\\Users\\me\\proj';          // as VS Code reports it
const WCWD  = 'C:\\Users\\me\\proj';          // as process.cwd() reports it
check('win: drive-letter case is the SAME project', P.underRoot(WCWD, WROOT, 'win32'), true);
check('win: and symmetrically', P.underRoot(WROOT, WCWD, 'win32'), true);
check('win: a subdirectory of it still belongs', P.underRoot(WCWD + '\\src\\deep', WROOT, 'win32'), true);
check('win: whole-path case folds too', P.underRoot('C:\\USERS\\ME\\PROJ', WROOT, 'win32'), true);
check('win: a forward-slash cwd still matches', P.underRoot('C:/Users/me/proj/src', WROOT, 'win32'), true);
check('win: a trailing separator does not break it', P.underRoot(WCWD + '\\', WROOT, 'win32'), true);

// THE LOAD-BEARING HALF. isOurs is what stops another project's run moving this
// panel, and it is one of the three layers guarding the generation loop, so a
// normalisation that made everything match would be worse than the bug.
check('win: a DIFFERENT project is still rejected',
  P.underRoot('C:\\Users\\me\\other', WROOT, 'win32'), false);
check('win: a sibling sharing a prefix is rejected',
  P.underRoot('C:\\Users\\me\\proj-two', WROOT, 'win32'), false);
check('win: a different drive is rejected',
  P.underRoot('D:\\Users\\me\\proj', WROOT, 'win32'), false);
check('win: a parent is not "under" the root',
  P.underRoot('C:\\Users\\me', WROOT, 'win32'), false);

// POSIX must NOT fold case: /tmp/A and /tmp/a are genuinely different dirs.
check('posix: exact path matches', P.underRoot('/home/me/proj', '/home/me/proj', 'linux'), true);
check('posix: subdirectory matches', P.underRoot('/home/me/proj/src', '/home/me/proj', 'linux'), true);
check('posix: case is SIGNIFICANT and must not match',
  P.underRoot('/home/me/PROJ', '/home/me/proj', 'linux'), false);
check('posix: prefix sibling is rejected',
  P.underRoot('/home/me/proj-two', '/home/me/proj', 'linux'), false);
check('posix: foreign project is rejected',
  P.underRoot('/home/me/other', '/home/me/proj', 'linux'), false);
check('darwin behaves exactly as linux here',
  P.underRoot('/Users/me/PROJ', '/Users/me/proj', 'darwin'), false);

// The "nothing to disagree with" escape hatch, unchanged from v1.
check('no root means accept', P.underRoot('/anything', '', 'darwin'), true);
check('no cwd means accept', P.underRoot('', '/home/me/proj', 'darwin'), true);

console.log('\n=== 2. retargeting hooks is surgical ===');
const settings = {
  permissions: { allow: ['Bash(ls)'] },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:41777/hook', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:41777/hook', timeout: 10 }] }],
    // someone else's hook, which must not be touched
    PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
    PostToolUse: [{ hooks: [{ type: 'http', url: 'https://example.com/not-ours' }] }]
  }
};
check('finds the ports currently configured', P.configuredPorts(settings), [41777]);
const out = P.retargetHooks(JSON.parse(JSON.stringify(settings)), 41842);
check('reports what it changed', out.changedFrom, [41777, 41777]);
check('both Yield hooks now point at the project port', P.configuredPorts(out.settings), [41842]);
check('a command hook is untouched',
  out.settings.hooks.PreToolUse[0].hooks[0].command, 'echo hi');
check('a foreign http hook is untouched',
  out.settings.hooks.PostToolUse[0].hooks[0].url, 'https://example.com/not-ours');
check('unrelated settings survive', out.settings.permissions.allow, ['Bash(ls)']);
check('the timeout field survives', out.settings.hooks.Stop[0].hooks[0].timeout, 10);
check('re-running is a no-op', P.retargetHooks(out.settings, 41842), undefined);
check('a file with no hooks is left alone', P.retargetHooks({ permissions: {} }, 41842), undefined);

// ============================ 3. real sockets: routing between two projects
//
// The port RACE is no longer tested here: windows no longer wait for each other
// at all, they claim a different port. scratchpad/port-claim.js covers that
// end to end. What still matters here is that a window serves the caller's
// project and ignores everyone else's.

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-win-'));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-other-'));
fs.mkdirSync(path.join(WS, '.yield'));
fs.writeFileSync(path.join(WS, '.yield', 'yield-context.md'), '# Project context\n\n## Notes\n\n- MY project note\n');
fs.mkdirSync(path.join(OTHER, '.yield'));
fs.writeFileSync(path.join(OTHER, '.yield', 'yield-context.md'), '# Project context\n\n## Notes\n\n- OTHER project note\n');

const OURS = P.projectPort(WS);
const posted = [];
const logged = [];

const vscodeStub = {
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString: () => 'r:' + path.join(base.fsPath, ...p) }),
    file: (f) => ({ fsPath: f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: { workspaceFolders: [{ uri: { fsPath: WS } }], openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
        set html(v) { this._h = v; }, get html() { return this._h; },
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (cb) => { vscodeStub._onMsg = cb; return { dispose() {} }; }
      },
      reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), viewColumn: 1
    }),
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd, uri, opts) => { vscodeStub._executed.push({ cmd, uri, opts }); }
  },
  _executed: [], _cmds: {}, _onMsg: null
};

const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') { return vscodeStub; }
  return realLoad.apply(this, arguments);   // REAL http
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));

const chip = () => { const r = posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].statusLabel : '(none)'; };
const deaf = () => { const r = posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].cardClass.includes('deaf') : null; };

function post(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(WS, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} },
    extension: { packageJSON: { version: 'test' } }
  });
  await vscodeStub._cmds['yield.open']();
  vscodeStub._onMsg({ type: 'ready' });
  await wait(600);
  const OURS = P.configuredPorts(JSON.parse(fs.readFileSync(path.join(WS, '.claude', 'settings.json'), 'utf8')))[0];
  report('claimed', OURS);
  check('it is listening', chip(), 'Idle');

  console.log('\n=== 5. it only reacts to its OWN project ===');
  const body = await post(OURS, { hook_event_name: 'UserPromptSubmit', prompt: 'my own work', cwd: WS });
  check('own project flips the chip', chip(), 'Agent is working');
  check('and injects our notes', JSON.parse(body).hookSpecificOutput.additionalContext.includes('MY project note'), true);
  await post(OURS, { hook_event_name: 'Stop', cwd: WS });
  await wait(50);

  const foreign = await post(OURS, { hook_event_name: 'UserPromptSubmit', prompt: 'someone else', cwd: OTHER });
  check('a FOREIGN project does not touch this panel', chip(), 'Idle');
  const inj = JSON.parse(foreign).hookSpecificOutput.additionalContext;
  check('but it is served the CALLER\'s notes, not ours', inj.includes('OTHER project note'), true);
  check('and never leaks our notes into their session', inj.includes('MY project note'), false);


  try { ext.deactivate(); } catch (e) { /* ignore */ }
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(OTHER, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
