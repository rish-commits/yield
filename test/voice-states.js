// STAGE 3 — the v78 voice states, end to end, against the COMPILED build.
//
// A minimal DOM lets the REAL media/panel.js run in Node, wired to the REAL
// out/extension.js, which spawns the REAL whisper binary on REAL audio. The
// only fakes are the browser APIs a webview would provide (MediaRecorder,
// AudioContext, getUserMedia) — and those are instrumented, because half of
// what stage 3 has to prove is about how they are used: one stream, one
// permission, nothing leaked.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
// Real recordings, deliberately NOT committed: they are someone's voice.
// Point YIELD_TEST_FIXTURES at a directory holding known.wav / src48.wav
// to run these; without it the suite says so instead of crashing.
const FIXTURES = process.env.YIELD_TEST_FIXTURES
  || path.join(ROOT, 'scratchpad', 'audio');
const MODEL_CACHE = path.join(process.env.HOME, '.cache', 'yield-whisper');

// ------------------------------------------------------------------ fake DOM

function makeEl(tag) {
  const el = {
    tagName: tag, children: [], _listeners: {}, _classes: new Set(),
    style: { setProperty(k, v) { this[k] = v; } },
    textContent: '', innerHTML: '', value: '', placeholder: '', title: '',
    disabled: false, scrollHeight: 20, scrollTop: 0, clientHeight: 100,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    fire(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev || {})); },
    focus() {}, setSelectionRange() {}, scrollTo(o) { this.scrollTop = o.top; },
    querySelector(sel) { return this._q ? this._q(sel) : makeEl('div'); },
    cloneNode() { const c = makeEl(this.tagName); c._q = this._q; return c; },
    getBoundingClientRect: () => ({ width: 400, height: 100 })
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
  'ctxbtn', 'openbtn', 'closebtn', 'ctxlabel', 'micbtn', 'wave', 'vstate', 'vstop',
  'noticetext', 'retrybtn', 'cprog', 'newmsg'];
const el = {};
ids.forEach((i) => { el[i] = makeEl('div'); });
el.ctxlabel.textContent = 'yield-context.md';

const tpl = makeEl('template');
tpl.content = { firstElementChild: makeEl('button') };
tpl.content.firstElementChild._q = () => makeEl('span');
el['qopt-tpl'] = tpl;

const composerEl = makeEl('div');
const markEl = makeEl('img'); markEl.src = 'logo.svg';

// ---------------------------------------------------- instrumented browser API

const spy = {
  getUserMediaCalls: 0,
  audioContextsCreated: 0,
  audioContextsClosed: 0,
  tracksStopped: 0,
  streamsCreated: 0,
  analysersCreated: 0
};

let CLIP_BYTES = fs.readFileSync(path.join(FIXTURES, 'known.wav'));
let failNextDecode = false;

function makeTrack() { return { stop() { spy.tracksStopped++; } }; }
function makeStream() {
  spy.streamsCreated++;
  const tracks = [makeTrack()];
  return { getTracks: () => tracks };
}

class FakeAudioContext {
  constructor() { spy.audioContextsCreated++; this.closed = false; }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() {
    spy.analysersCreated++;
    return {
      fftSize: 2048, smoothingTimeConstant: 0, frequencyBinCount: 512,
      // A rising spectrum, so the painted bars are demonstrably not uniform.
      getByteFrequencyData(arr) { for (let i = 0; i < arr.length; i++) { arr[i] = Math.min(255, 40 + i / 2); } }
    };
  }
  decodeAudioData(buf) {
    if (failNextDecode) { failNextDecode = false; return Promise.reject(new Error('decode failed')); }
    return Promise.resolve(readWavAsAudioBuffer(Buffer.from(buf)));
  }
  close() { this.closed = true; spy.audioContextsClosed++; return Promise.resolve(); }
}

class FakeMediaRecorder {
  constructor(stream) { this.stream = stream; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    // Hand back the real clip as the "recording".
    if (this.ondataavailable) { this.ondataavailable({ data: { size: CLIP_BYTES.length, type: 'audio/webm' } }); }
    if (this.onstop) { this.onstop(); }
  }
}

function readWavAsAudioBuffer(b) {
  const channels = b.readUInt16LE(22), sampleRate = b.readUInt32LE(24);
  let off = 12, dOff = 44, dLen = b.length - 44;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    if (id === 'data') { dOff = off + 8; dLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  const frames = dLen / (channels * 2);
  const out = [];
  for (let c = 0; c < channels; c++) { out.push(new Float32Array(frames)); }
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) { out[c][i] = b.readInt16LE(dOff + (i * channels + c) * 2) / 32768; }
  }
  return { numberOfChannels: channels, sampleRate, length: frames, getChannelData: (i) => out[i] };
}

// -------------------------------------------------- the compiled extension host

const posted = [];       // extension -> webview
const fromWebview = [];  // webview -> extension
let webviewOnMessage = null;
const STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-s3-'));

const vscodeStub = {
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString: () => 'r:' + path.join(base.fsPath, ...p) }),
    file: (f) => ({ fsPath: f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: { workspaceFolders: [{ uri: { fsPath: STORE_ROOT } }], openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
        set html(v) { this._h = v; }, get html() { return this._h; },
        postMessage: (m) => { posted.push(m); deliverToWebview(m); return Promise.resolve(true); },
        onDidReceiveMessage: (cb) => { webviewOnMessage = cb; return { dispose() {} }; }
      },
      reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), viewColumn: 1
    }),
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    // the file affordance now goes through `vscode.open`
    executeCommand: async (cmd, uri, opts) => { vscodeStub._executed.push({ cmd, uri, opts }); }
  },
  _executed: [],
  _cmds: {}
};

const realLoad = Module._load;
Module._load = function (req) {
  if (req === 'vscode') { return vscodeStub; }
  if (req === 'http') { return { createServer: () => ({ on() {}, listen: (p, h, cb) => cb && cb(), close() {} }) }; }
  return realLoad.apply(this, arguments);
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));

// ------------------------------------------------- run the REAL webview scripts

const rafQueue = [];
let windowListeners = [];

const sandbox = {
  console,
  Buffer,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  cancelAnimationFrame: () => { rafQueue.length = 0; },
  AudioContext: FakeAudioContext,
  MediaRecorder: FakeMediaRecorder,
  Blob: class { constructor(parts) { this.size = CLIP_BYTES.length; this.type = 'audio/webm'; }
                arrayBuffer() { return Promise.resolve(CLIP_BYTES.buffer.slice(CLIP_BYTES.byteOffset, CLIP_BYTES.byteOffset + CLIP_BYTES.length)); } },
  navigator: { mediaDevices: { getUserMedia: () => { spy.getUserMediaCalls++; return Promise.resolve(makeStream()); } } },
  acquireVsCodeApi: () => ({ postMessage: (m) => { fromWebview.push(m); if (webviewOnMessage) { webviewOnMessage(m); } } }),
  document: {
    getElementById: (id) => el[id] || null,
    querySelector: (sel) => (sel === '.composer' ? composerEl : sel === '.markwrap .mark' ? markEl : makeEl('div')),
    createElement: (t) => makeEl(t),
    addEventListener() {}
  },
  addEventListener: (t, fn) => { if (t === 'message') { windowListeners.push(fn); } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
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
async function until(fn, ms = 180000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) { throw new Error('timed out waiting for a condition'); }
    await wait(40);
  }
}
const composerClasses = () => [...composerEl._classes].sort().join(' ') || '(none)';

(async () => {
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: MODEL_CACHE },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  await vscodeStub._cmds['yield.open']();
  webviewOnMessage({ type: 'ready' });
  await wait(80);

  console.log('\n=== 1. the mic is live on a supported machine ===');
  check('mic enabled', el.micbtn.disabled, false);
  check('tooltip is the real affordance', el.micbtn.title, 'Speak instead');
  check('30 mirrored bars built (15 bins x2)', el.wave.children.length, 30);
  check('per-bar stagger index set for the scan keyframes', el.wave.children[7].style['--i'], 7);

  console.log('\n=== 2. RECORDING ===');
  el.micbtn.fire('click');
  await until(() => composerEl.classList.contains('voice'));
  check('composer wears the dark voice surface', composerEl.classList.contains('voice'), true);
  check('stop control is live', el.vstop.disabled, false);
  check('timer starts at 0:00', el.vstate.textContent, '0:00');
  check('exactly ONE getUserMedia call', spy.getUserMediaCalls, 1);
  check('analyser hangs off that same stream (1 stream, 1 analyser)',
    [spy.streamsCreated, spy.analysersCreated], [1, 1]);

  // drive a frame of the waveform
  const frame = rafQueue.shift(); if (frame) { frame(); }
  const heights = [...el.wave.children].map((b) => parseFloat(b.style.height) || 0);
  report('bar heights (px)', heights.slice(0, 8).map((h) => h.toFixed(1)).join(' '));
  check('bars driven by real amplitude, not uniform', new Set(heights).size > 1, true);
  check('bars mirror around the centreline', heights[14].toFixed(1), heights[15].toFixed(1));
  check('heights stay within the 2-32px band',
    heights.every((h) => h >= 2 && h <= 32), true);

  console.log('\n=== 3. TRANSCRIBING -> REVIEWING ===');
  el.vstop.fire('click');
  await until(() => composerEl.classList.contains('settled'));
  check('bars settle into the scan state', composerClasses(), 'settled voice');
  check('stop is disabled while transcribing', el.vstop.disabled, true);
  check('label reads Transcribing', el.vstate.textContent, 'Transcribing…');
  check('stream torn down the moment capture ended', spy.tracksStopped, 1);

  await until(() => posted.some((m) => m.type === 'transcript'));
  await wait(60);
  const transcript = posted.filter((m) => m.type === 'transcript').pop().text;
  report('transcript', JSON.stringify(transcript));
  check('composer returns to light for review', composerClasses(), '(none)');
  check('transcript is in the composer, editable', el.input.value, transcript);
  check('send is enabled', el.sendbtn.disabled, false);
  check('0.5s padding survived the port: first word intact',
    transcript.toLowerCase().replace(/[^a-z ]/g, '').trim().split(' ')[0], 'the');
  check('nothing was auto-saved', posted.filter((m) => m.type === 'saved').length, 0);

  console.log('\n=== 4. edit, then save ===');
  el.input.value = transcript + ' Also prefer pnpm.';
  el.input.fire('keydown', { key: 'Enter', shiftKey: false, preventDefault() {} });
  await until(() => posted.some((m) => m.type === 'saved'));
  await wait(120);
  const store = fs.readFileSync(path.join(STORE_ROOT, '.yield', 'yield-context.md'), 'utf8');
  check('the edited note reached .yield/yield-context.md', store.includes('Also prefer pnpm.'), true);
  check('the spoken part is in there too', store.includes('quick brown fox'), true);
  const label = posted.filter((m) => m.type === 'render').pop().noteLabel;
  check('note count bumped', label, '1 note');

  console.log('\n=== 5. append, never overwrite (a half-typed note survives) ===');
  el.input.value = 'Half typed thought';
  spy.getUserMediaCalls = 0;
  el.micbtn.fire('click');
  await until(() => composerEl.classList.contains('voice'));
  el.vstop.fire('click');
  await until(() => posted.filter((m) => m.type === 'transcript').length >= 2);
  await wait(60);
  check('draft kept and transcript appended', el.input.value.startsWith('Half typed thought '), true);
  check('the transcript followed it', el.input.value.includes('quick brown fox'), true);

  console.log('\n=== 6. five record/stop cycles — nothing leaks ===');
  const before = { ctx: spy.audioContextsCreated, closed: spy.audioContextsClosed, stopped: spy.tracksStopped };
  for (let i = 0; i < 5; i++) {
    el.input.value = '';
    el.micbtn.fire('click');
    await until(() => composerEl.classList.contains('voice'));
    el.vstop.fire('click');
    await until(() => posted.filter((m) => m.type === 'transcript').length >= 3 + i);
    await wait(40);
  }
  const made = spy.audioContextsCreated - before.ctx;
  const closed = spy.audioContextsClosed - before.closed;
  report('AudioContexts created across 5 cycles', made);
  report('AudioContexts closed', closed);
  report('stream tracks stopped', spy.tracksStopped - before.stopped);
  check('every AudioContext was closed — none leaked', made - closed, 0);
  // ONE context per recording: the analyser and decodeAudioData share it.
  check('exactly one AudioContext per recording, not two', made, 5);
  check('every stream was stopped', spy.tracksStopped - before.stopped, 5);
  check('still exactly one getUserMedia per recording', spy.getUserMediaCalls, 6);

  console.log('\n=== 7a. the HOST really does fail, and says so ===');
  // Garbage instead of a WAV: whisper-cli exits non-zero and the extension must
  // turn that into a voiceFailed message rather than a hang or a crash.
  const failMark = posted.length;
  webviewOnMessage({ type: 'transcribe', wav: Buffer.from('this is not audio').toString('base64') });
  await until(() => posted.slice(failMark).some((m) => m.type === 'voiceFailed'));
  const failMsg = posted.slice(failMark).find((m) => m.type === 'voiceFailed');
  report('host reported', JSON.stringify(failMsg.reason));
  check('a bad clip produces voiceFailed, not a crash', typeof failMsg.reason, 'string');
  await wait(60);
  check('composer shows the notice state', composerEl.classList.contains('notice'), true);
  check('the message keeps the promise', el.noticetext.innerHTML.includes('Your recording is safe'), true);

  console.log('\n=== 7b. Retry re-runs the RETAINED audio, no re-recording ===');
  // A GENUINE host failure on a REAL recording: make the model unreadable so
  // whisper exits non-zero. That is a transient fault, which is the realistic
  // case for Retry — the audio is fine, the run was not.
  const modelPath = path.join(MODEL_CACHE, 'ggml-base.en.bin');
  fs.chmodSync(modelPath, 0o000);

  el.input.value = '';
  const gumBeforeRetry = spy.getUserMediaCalls;
  const failsBefore = posted.filter((m) => m.type === 'voiceFailed').length;
  el.micbtn.fire('click');
  await until(() => composerEl.classList.contains('voice'));
  el.vstop.fire('click');
  try {
    await until(() => posted.filter((m) => m.type === 'voiceFailed').length > failsBefore, 60000);
  } finally {
    fs.chmodSync(modelPath, 0o644);          // never leave the model broken
  }
  await wait(80);

  const failure = posted.filter((m) => m.type === 'voiceFailed').pop();
  report('host reported', JSON.stringify(failure.reason));
  check('a failed recording shows the notice state', composerEl.classList.contains('notice'), true);
  check('the message keeps the promise', el.noticetext.innerHTML.includes('Your recording is safe'), true);
  check('Retry is offered because the audio was retained', el.retrybtn.style.display, 'block');
  check('no transcript landed, so the composer was left alone', el.input.value, '');

  // The fault has cleared (permissions restored) — exactly when a user retries.
  const sentBefore = fromWebview.filter((m) => m.type === 'transcribe').length;
  const tBefore2 = posted.filter((m) => m.type === 'transcript').length;
  el.retrybtn.fire('click');
  await wait(80);
  const sent = fromWebview.filter((m) => m.type === 'transcribe');
  check('Retry re-sent audio to the host', sent.length - sentBefore, 1);
  check('Retry did NOT ask for the mic again', spy.getUserMediaCalls, gumBeforeRetry + 1);
  check('it re-sent the SAME retained audio, byte for byte',
    sent[sent.length - 1].wav === sent[sent.length - 2].wav, true);
  check('the webview shows transcribing again', composerEl.classList.contains('settled'), true);

  await until(() => posted.filter((m) => m.type === 'transcript').length > tBefore2);
  await wait(80);
  check('the retry SUCCEEDED on the retained audio', el.input.value.includes('quick brown fox'), true);
  check('and it never re-recorded', spy.getUserMediaCalls, gumBeforeRetry + 1);

  console.log('\n=== 8. FIRST RUN state fires BEFORE the spawn ===');
  const { isVerified, firstRunMarker } = require(path.join(ROOT, 'out', 'whisper.js'));
  check('marker exists after successful runs', await isVerified(MODEL_CACHE), true);
  // Remove it to replay a fresh install, and watch the ORDER of events.
  fs.rmSync(firstRunMarker(MODEL_CACHE), { force: true });
  const markAt = posted.length;
  el.input.value = '';
  el.micbtn.fire('click');
  await until(() => composerEl.classList.contains('voice'));
  el.vstop.fire('click');
  await until(() => posted.slice(markAt).some((m) => m.type === 'voiceStage'));
  const firstStage = posted.slice(markAt).find((m) => m.type === 'voiceStage');
  check('the first stage announced is "preparing"', firstStage.stage, 'preparing');
  check('and it lands before any transcript',
    posted.slice(markAt).findIndex((m) => m.type === 'voiceStage') <
    (posted.slice(markAt).findIndex((m) => m.type === 'transcript') + 1 || 1e9), true);
  await wait(60);
  check('composer shows the indeterminate first-run notice',
    composerEl.classList.contains('notice') && composerEl.classList.contains('indet'), true);
  check('copy is the agreed line', el.noticetext.textContent, 'Preparing voice. This happens once after install.');
  await until(() => posted.slice(markAt).some((m) => m.type === 'transcript'));
  await wait(120);
  check('marker rewritten after the run', await isVerified(MODEL_CACHE), true);

  console.log('\n=== 9. DOWNLOADING state renders real percentages ===');
  deliverToWebview({ type: 'voiceStage', stage: 'downloading', pct: 42 });
  await wait(20);
  check('notice shows the real percentage', el.noticetext.innerHTML, 'Downloading voice model… <b>42%</b>');
  check('progress line tracks it', el.cprog.style.width, '42%');
  check('composer stays light while downloading', composerEl.classList.contains('voice'), false);

  console.log('\n=== 10. platform fallback still disables the mic ===');
  deliverToWebview({ type: 'render', cardClass: 'card', statusLabel: 'Idle', questions: [], noteLabel: '1 note',
    voice: { ok: false, reason: 'Voice needs Apple silicon — this Mac is x64' } });
  await wait(20);
  check('mic disabled', el.micbtn.disabled, true);
  check('tooltip carries the real reason', el.micbtn.title, 'Voice needs Apple silicon — this Mac is x64');
  spy.getUserMediaCalls = 0;
  el.micbtn.fire('click');
  await wait(40);
  check('clicking a disabled mic does nothing at all', spy.getUserMediaCalls, 0);

  fs.rmSync(STORE_ROOT, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
