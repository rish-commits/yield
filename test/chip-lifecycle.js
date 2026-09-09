// Drives out/extension.js — the real compiled build — through the hook
// lifecycle with `vscode` and `http` stubbed, so the chip label sequence is
// checked against the shipping code rather than against a reading of it.
const Module = require('module');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');
const os = require('os');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-e2e-'));
fs.mkdirSync(path.join(root, '.yield'));
fs.writeFileSync(path.join(root, '.yield', 'yield-context.md'),
  '# Project context\n\n## Notes\n\n- prefers pnpm\n- deploys to Vercel\n');

const posted = [];          // everything the extension pushes to the webview
const logged = [];          // the Yield output channel
let webviewOnMessage = null;
let disposed = false;
let opened = null;

const vscodeStub = {
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString: () => 'vscode-resource:' + path.join(base.fsPath, ...p) }),
    file: (f) => ({ fsPath: f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: [{ uri: { fsPath: root } }],
    openTextDocument: async (f) => { opened = f; return { f }; }
  },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'vscode-resource:',
        asWebviewUri: (u) => ({ toString: () => 'vscode-resource:' + u.fsPath }),
        set html(v) { this._html = v; },
        get html() { return this._html; },
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (cb) => { webviewOnMessage = cb; return { dispose() {} }; }
      },
      reveal() {}, dispose() { disposed = true; },
      onDidDispose: () => ({ dispose() {} }),
      viewColumn: 1
    }),
    showTextDocument: async () => {},
    showErrorMessage: (m) => logged.push('ERR ' + m),
    showWarningMessage: (m) => logged.push('WARN ' + m)
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    // the file affordance now goes through `vscode.open`
    executeCommand: async (cmd, uri, opts) => { vscodeStub._executed.push({ cmd, uri, opts }); }
  },
  _executed: [],
  _cmds: {}
};

let hookHandler = null;
const httpStub = {
  createServer: (h) => { hookHandler = h; const s = { listening: false, on() {}, listen(p, hst, cb) { s.listening = true; cb && cb(); }, close() { s.listening = false; } }; return s; }
};

const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') { return vscodeStub; }
  if (req === 'http') { return httpStub; }
  return realLoad.apply(this, arguments);
};

const ext = require(path.join(ROOT, 'out', 'extension.js'));

// --- fire a hook exactly the way Claude Code's HTTP hook does
function hook(payload) {
  return new Promise((resolve) => {
    const listeners = {};
    const req = { method: 'POST', on: (ev, cb) => { listeners[ev] = cb; } };
    const res = { writeHead() {}, end: (body) => resolve(body) };
    hookHandler(req, res);
    listeners.data(Buffer.from(JSON.stringify(payload)));
    listeners.end();
  });
}

const chip = () => { const r = posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].statusLabel : '(none)'; };
const dot  = () => { const r = posted.filter((m) => m.type === 'render'); return r.length ? (/\bworking\b/.test(r[r.length - 1].cardClass) ? 'green' : 'grey') : '(none)'; };

const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}

(async () => {
  ext.activate({ extensionUri: { fsPath: process.cwd() }, globalStorageUri: { fsPath: require('os').tmpdir() }, subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } } });

  // --- 1. panel opened BEFORE any task: this is the path that used to strand
  //        the chip, because the first render fired before the webview listened.
  await vscodeStub._cmds['yield.open']();
  const firstFrame = /id="statusLabel">([^<]*)</.exec(posted.length ? '' : '');
  const html = vscodeStub.window.createWebviewPanel.name; // unused, keep lint quiet
  check('no render is pushed before the webview says ready', posted.filter(m => m.type === 'render').length, 0);

  webviewOnMessage({ type: 'ready' });
  check('ready handshake paints the chip', chip(), 'Idle');
  check('ready handshake paints the real note count', posted.filter(m => m.type === 'render').pop().noteLabel, '2 notes');

  // --- 2. the lifecycle proper
  const body = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'add a deploy pipeline', cwd: root });
  check('UserPromptSubmit flips the chip', chip(), 'Agent is working');
  check('UserPromptSubmit turns the dot green', dot(), 'green');
  const parsed = JSON.parse(body);
  check('the same round-trip carries the injection',
    parsed.hookSpecificOutput.additionalContext.includes('prefers pnpm') &&
    parsed.hookSpecificOutput.additionalContext.includes('deploys to Vercel'), true);
  check('injection is suppressed from the transcript', parsed.suppressOutput, true);

  // a note saved MID-RUN must not disturb the chip (two independent timelines)
  webviewOnMessage({ type: 'note', text: 'use pnpm, never npm', answering: null });
  await new Promise(r => setTimeout(r, 60));
  check('saving mid-run leaves the chip working', chip(), 'Agent is working');
  check('the note landed in the store',
    fs.readFileSync(path.join(root, '.yield', 'yield-context.md'), 'utf8').includes('- use pnpm, never npm'), true);
  check('the footer count grew', posted.filter(m => m.type === 'render').pop().noteLabel, '3 notes');
  check('and the reply came back', posted.filter(m => m.type === 'reply').length, 1);

  await hook({ hook_event_name: 'Stop', cwd: root });
  check('Stop returns the chip to Idle', chip(), 'Idle');
  check('Stop greys the dot', dot(), 'grey');

  // --- 3. a SECOND run, to prove it is not a one-shot
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'now write the tests', cwd: root });
  check('second run flips it again', chip(), 'Agent is working');
  await hook({ hook_event_name: 'Stop', cwd: root });
  check('second run settles again', chip(), 'Idle');

  // --- 4. the panel's own controls
  webviewOnMessage({ type: 'openStore' });
  await new Promise(r => setTimeout(r, 60));
  const opens = vscodeStub._executed.filter(e => e.cmd === 'vscode.open');
  check('the file affordance opens the real store', opens.length === 1 && String(opens[0].uri.fsPath || opens[0].uri).includes('yield-context.md'), true);
  check('it opens as a preview tab (no duplicate tabs on repeat clicks)', opens[0].opts && opens[0].opts.preview, true);
  check('no column is forced — the IDE decides where it lands', opens[0].opts && opens[0].opts.viewColumn, undefined);
  // (the in-webview close control was removed: the IDE already owns closing a
  //  docked view, and a second one had to fake it by disposing its own panel)

  console.log('\n--- chip transitions the extension logged ---');
  logged.filter(l => /chip:/.test(l)).forEach(l => console.log('   ' + l));
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
