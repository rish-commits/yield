// The regression itself: open the panel MID-RUN and read the opening frame.
// Before Phase E this painted `card working` (green dot) over a hardcoded
// "Idle" label and a hardcoded "12 notes", then never resynced.
const Module = require('module'); const path = require('path'); const fs = require('fs'); const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-ff-'));
fs.mkdirSync(path.join(root, '.yield'));
fs.writeFileSync(path.join(root, '.yield', 'yield-context.md'), '# Project context\n\n## Notes\n\n- only one note here\n');
let html = null, onMsg = null; const posted = [];
const v = {
  Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString: () => 'r:' + path.join(b.fsPath, ...p) }), file: f => ({ fsPath: f }) },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }), workspaceFolders: [{ uri: { fsPath: root } }], openTextDocument: async f => ({ f }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { cspSource: 'r:', asWebviewUri: u => ({ toString: () => 'r:' + u.fsPath }), set html(x) { html = x; }, get html() { return html; }, postMessage: m => posted.push(m), onDidReceiveMessage: cb => (onMsg = cb, { dispose() {} }) }, reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), viewColumn: 1 }),
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}
  },
  commands: {
    registerCommand: (id, fn) => (v._cmds[id] = fn, { dispose() {} }),
    executeCommand: async (cmd, uri, opts) => { v._executed.push({ cmd, uri, opts }); }
  }, _executed: [], _cmds: {}
};
let hookHandler = null;
const realLoad = Module._load;
Module._load = function (r) { if (r === 'vscode') return v; if (r === 'http') return { createServer: h => { hookHandler = h; const s = { listening: false, on() {}, listen: (p, hs, cb) => { s.listening = true; cb && cb(); }, close() { s.listening = false; } }; return s; } }; return realLoad.apply(this, arguments); };
const ext = require(path.join(ROOT, 'out', 'extension.js'));
function hook(p) { return new Promise(res => { const L = {}; hookHandler({ method: 'POST', on: (e, c) => L[e] = c }, { writeHead() {}, end: b => res(b) }); L.data(Buffer.from(JSON.stringify(p))); L.end(); }); }

(async () => {
  ext.activate({ extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: require('os').tmpdir() }, subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } } });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor the auth layer', cwd: root });
  await v._cmds['yield.open']();                     // panel opens MID-RUN

  const label = /id="statusLabel">([^<]*)</.exec(html)[1];
  const cls   = /<div class="([^"]*)" id="card"/.exec(html)[1];
  const foot  = /id="ctxlabel">([^<]*)</.exec(html)[1];
  const green = /\bworking\b/.test(cls);
  const out = [
    ['opening frame chip label',        label, 'Agent is working'],
    ['opening frame dot',               green ? 'green' : 'grey', 'green'],
    ['label and dot agree',             (label === 'Agent is working') === green, true],
    ['opening frame footer is real',    foot, '1 note'],
    ['no unfilled placeholder left',    /{{\w+}}/.test(html), false]
  ];
  let ok = true;
  out.forEach(([n, a, e]) => { const p = a === e; ok = ok && p; console.log(`${p ? 'PASS' : 'FAIL'}  ${n}\n        got ${JSON.stringify(a)}${p ? '' : `  want ${JSON.stringify(e)}`}`); });

  onMsg({ type: 'ready' });
  const r = posted.filter(m => m.type === 'render').pop();
  const p2 = r.statusLabel === 'Agent is working' && r.questions.length > 0;
  ok = ok && p2;
  console.log(`${p2 ? 'PASS' : 'FAIL'}  ready resyncs mid-run (chip ${JSON.stringify(r.statusLabel)}, ${r.questions.length} question(s): ${JSON.stringify(r.questions.map(q => q.id))})`);
  process.exit(ok ? 0 : 1);
})();
