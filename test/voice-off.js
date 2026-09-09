// v1 CLOSE-OUT — the shipped configuration: VOICE_ENABLED = false.
//
// Proves the mic is GONE (not disabled), that no voice code path can run, that
// the close control is gone, and that both file affordances open the same file
// the same way — from a CLEAN workspace with no .yield/ folder.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ------------------------------------------------------------------ fake DOM

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], _listeners: {}, _classes: new Set(),
    style: { setProperty(k, v) { this[k] = v; } },
    textContent: '', innerHTML: '', value: '', placeholder: '', title: '',
    disabled: false, scrollHeight: 20, scrollTop: 0, clientHeight: 100, parentNode: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); } c.parentNode = null; return c; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    fire(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    focus() {}, setSelectionRange() {}, scrollTo(o) { this.scrollTop = o.top; },
    querySelector() { return this._q ? this._q() : makeEl('div'); },
    cloneNode() { const c = makeEl(this.tagName); c._q = this._q; return c; }
  };
  el.classList = {
    add: (...c) => c.forEach((x) => el._classes.add(x)),
    remove: (...c) => c.forEach((x) => el._classes.delete(x)),
    contains: (c) => el._classes.has(c),
    toggle: (c, on) => { const v = on === undefined ? !el._classes.has(c) : on; v ? el._classes.add(c) : el._classes.delete(c); return v; }
  };
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  return el;
}

const ids = ['card', 'statusLabel', 'qopts', 'stream', 'inner', 'input', 'sendbtn',
  'ctxbtn', 'openbtn', 'ctxlabel', 'micbtn', 'wave', 'vstate', 'vstop',
  'noticetext', 'retrybtn', 'cprog', 'newmsg'];
const el = {};
ids.forEach((i) => { el[i] = makeEl('div'); });
el.ctxlabel.textContent = 'yield-context.md';
// The mic lives in a real parent, so "removed from the DOM" is verifiable.
const cbtns = makeEl('div');
cbtns.appendChild(el.micbtn);
cbtns.appendChild(el.sendbtn);

const tpl = makeEl('template');
tpl.content = { firstElementChild: makeEl('button') };
tpl.content.firstElementChild._q = () => makeEl('span');
el['qopt-tpl'] = tpl;
const composerEl = makeEl('div');
const markEl = makeEl('img'); markEl.src = 'logo.svg';

const spy = { getUserMediaCalls: 0, audioContextsCreated: 0 };

// ------------------------------------------------- the compiled extension host

const posted = [];
let webviewOnMessage = null;
let paintedHtml = '';   // the FIRST frame, before any message lands
// A CLEAN workspace: no .yield/ anywhere in it.
const STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-clean-'));

const vscodeStub = {
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString: () => 'r:' + path.join(base.fsPath, ...p) }),
    file: (f) => ({ fsPath: f, toString: () => 'file://' + f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: { workspaceFolders: [{ uri: { fsPath: STORE_ROOT } }], openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
        set html(v) { this._h = v; paintedHtml = v; }, get html() { return this._h; },
        postMessage: (m) => { posted.push(m); deliverToWebview(m); return Promise.resolve(true); },
        onDidReceiveMessage: (cb) => { webviewOnMessage = cb; return { dispose() {} }; }
      },
      reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), viewColumn: 1
    }),
    showTextDocument: async () => { vscodeStub._showTextDocumentCalls++; },
    showErrorMessage: (m) => logged.push('ERR ' + m), showWarningMessage: (m) => logged.push('WARN ' + m)
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd, uri, opts) => { vscodeStub._executed.push({ cmd, uri, opts }); }
  },
  _executed: [], _showTextDocumentCalls: 0, _cmds: {}
};
const logged = [];

const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') { return vscodeStub; }
  if (req === 'http') { return { createServer: () => ({ on() {}, listen: (p, h, cb) => cb && cb(), close() {} }) }; }
  return realLoad.apply(this, arguments);
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));

// ------------------------------------------------- run the REAL webview script

let windowListeners = [];
const sandbox = {
  console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  AudioContext: class { constructor() { spy.audioContextsCreated++; } close() {} },
  MediaRecorder: class { start() {} stop() {} },
  Blob: class { constructor() { this.size = 0; } },
  navigator: { mediaDevices: { getUserMedia: () => { spy.getUserMediaCalls++; return Promise.resolve({ getTracks: () => [] }); } } },
  acquireVsCodeApi: () => ({ postMessage: (m) => { if (webviewOnMessage) { webviewOnMessage(m); } } }),
  document: {
    getElementById: (id) => el[id] || null,
    querySelector: (sel) => (sel === '.composer' ? composerEl : sel === '.markwrap .mark' ? markEl : makeEl('div')),
    createElement: (t) => makeEl(t), addEventListener() {}
  },
  addEventListener: (t, fn) => { if (t === 'message') { windowListeners.push(fn); } }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
function deliverToWebview(msg) { windowListeners.forEach((fn) => fn({ data: msg })); }
vm.runInContext(fs.readFileSync(path.join(ROOT, 'media/wav.js'), 'utf8'), sandbox, { filename: 'wav.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8'), sandbox, { filename: 'panel.js' });

// ------------------------------------------------------------------ the checks

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const storeFile = path.join(STORE_ROOT, '.yield', 'yield-context.md');
  check('workspace starts clean — no .yield/ folder', fs.existsSync(path.join(STORE_ROOT, '.yield')), false);

  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(STORE_ROOT, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  check('activation alone does NOT create .yield/', fs.existsSync(path.join(STORE_ROOT, '.yield')), false);
  report('activation log', logged.find((l) => /voice:/.test(l)).split('  ').pop());

  await vscodeStub._cmds['yield.open']();

  console.log('\n=== 1. the shipped first frame ===');
  const cardClass = /<div class="([^"]*)" id="card"/.exec(paintedHtml)[1];
  report('first-frame card class', JSON.stringify(cardClass));
  check('no-voice is painted server-side, so the mic never flashes', cardClass.includes('no-voice'), true);
  check('the close (X) button is gone from the markup', /closebtn|title="close"/.test(paintedHtml), false);
  check('the file icon survives', /id="openbtn"/.test(paintedHtml), true);
  check('no unfilled placeholder', /\{\{\w+\}\}/.test(paintedHtml), false);
  check('opening the panel seeds the store', fs.existsSync(storeFile), true);
  check('the seeded file has the header', fs.readFileSync(storeFile, 'utf8').startsWith('# Project context'), true);

  webviewOnMessage({ type: 'ready' });
  await wait(80);

  console.log('\n=== 2. the mic is GONE, not disabled ===');
  const render = posted.filter((m) => m.type === 'render').pop();
  report('voice payload', JSON.stringify(render.voice));
  check('host reports voice disabled', render.voice.enabled, false);
  check('card carries no-voice', render.cardClass.includes('no-voice'), true);
  check('the mic node was removed from the DOM', cbtns.children.length, 1);
  check('what remains is the send button', cbtns.children[0] === el.sendbtn, true);
  check('the mic was never merely disabled', el.micbtn.disabled, false);

  console.log('\n=== 3. no voice code path can run ===');
  check('no getUserMedia call, ever', spy.getUserMediaCalls, 0);
  check('no AudioContext created', spy.audioContextsCreated, 0);
  // even if something posted a transcribe request, the host must refuse it
  const before = posted.length;
  webviewOnMessage({ type: 'transcribe', wav: Buffer.from('x').toString('base64') });
  await wait(120);
  const refusal = posted.slice(before).find((m) => m.type === 'voiceFailed');
  check('the host refuses a transcribe request outright', !!refusal, true);
  report('refusal reason', JSON.stringify(refusal.reason));
  check('no transcript was produced', posted.slice(before).some((m) => m.type === 'transcript'), false);

  console.log('\n=== 4. both doors open the same file, the same way ===');
  vscodeStub._executed.length = 0;
  el.openbtn.fire('click');    // header file icon
  await wait(60);
  el.ctxbtn.fire('click');     // footer note-count
  await wait(60);
  const opens = vscodeStub._executed.filter((e) => e.cmd === 'vscode.open');
  check('two clicks, two opens', opens.length, 2);
  check('both target the same file', opens[0].uri.fsPath === opens[1].uri.fsPath, true);
  check('and it is the store', opens[0].uri.fsPath, storeFile);
  check('both open as preview tabs', opens.every((o) => o.opts && o.opts.preview === true), true);
  check('no column forced — the IDE decides', opens.every((o) => !o.opts.viewColumn), true);
  check('showTextDocument is not used in parallel (one path only)', vscodeStub._showTextDocumentCalls, 0);

  console.log('\n=== 5. five clicks do not pile up tabs ===');
  vscodeStub._executed.length = 0;
  for (let i = 0; i < 5; i++) { el.ctxbtn.fire('click'); await wait(40); }
  const five = vscodeStub._executed.filter((e) => e.cmd === 'vscode.open');
  check('five clicks, five opens', five.length, 5);
  check('every one is a preview tab, so they reuse one tab', five.every((o) => o.opts.preview === true), true);
  const uris = new Set(five.map((o) => o.uri.fsPath));
  check('all five target one uri', uris.size, 1);

  console.log('\n=== 6. the rest of the panel is untouched ===');
  el.input.value = 'a note typed with voice off';
  el.input.fire('keydown', { key: 'Enter', shiftKey: false, preventDefault() {} });
  await wait(150);
  check('saving still works', fs.readFileSync(storeFile, 'utf8').includes('a note typed with voice off'), true);
  check('note count still updates', posted.filter((m) => m.type === 'render').pop().noteLabel, '1 note');
  check('the status chip still renders', typeof posted.filter((m) => m.type === 'render').pop().statusLabel, 'string');

  fs.rmSync(STORE_ROOT, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
