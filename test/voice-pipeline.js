// STAGE 2 — the pipeline, end to end, against the COMPILED build.
//
//   48 kHz stereo (what decodeAudioData really returns)
//     -> media/wav.js  (mono, 16 kHz, +0.5s lead silence, RIFF)
//     -> out/extension.js's webview message handler  (the shipping code)
//     -> whisper-cli subprocess
//     -> `transcript` message posted back at the webview
//
// Nothing is mocked between the WAV and the transcript: this spawns the real
// staged binary against the real model.
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// Real recordings, deliberately NOT committed: they are someone's voice.
// Point YIELD_TEST_FIXTURES at a directory holding known.wav / src48.wav
// to run these; without it the suite says so instead of crashing.
const FIXTURES = process.env.YIELD_TEST_FIXTURES
  || path.join(ROOT, 'scratchpad', 'audio');
const YieldWav = require(path.join(ROOT, 'media', 'wav.js'));
const MODEL_CACHE = path.join(process.env.HOME, '.cache', 'yield-whisper');

// ---------------------------------------------------------------- wav helpers

/** Minimal RIFF reader — enough to turn a test fixture into AudioBuffer shape. */
function readWav(file) {
  const b = fs.readFileSync(file);
  const channels = b.readUInt16LE(22);
  const sampleRate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  // walk the chunks rather than assuming data starts at 44
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size % 2);
  }
  const frames = dataLen / (channels * (bits / 8));
  const out = [];
  for (let c = 0; c < channels; c++) { out.push(new Float32Array(frames)); }
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[c][i] = b.readInt16LE(dataOff + (i * channels + c) * 2) / 32768;
    }
  }
  return { numberOfChannels: channels, sampleRate, length: frames, getChannelData: (i) => out[i] };
}

function wavHeader(bytes) {
  const b = Buffer.from(bytes);
  return {
    riff: b.toString('ascii', 0, 4),
    wave: b.toString('ascii', 8, 12),
    channels: b.readUInt16LE(22),
    sampleRate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
    dataBytes: b.readUInt32LE(40)
  };
}

/** How many leading samples are pure digital silence. */
function leadingSilentSamples(bytes) {
  const b = Buffer.from(bytes);
  let n = 0;
  for (let i = 44; i + 1 < b.length; i += 2) {
    if (b.readInt16LE(i) !== 0) { break; }
    n++;
  }
  return n;
}

/** Cuts every silent sample off the front, so the clip starts HARD on a word.
 *  This is the condition that made whisper eat the first word in stage 1. */
function trimToHardStart(buf) {
  const data = buf.getChannelData(0);
  let first = 0;
  while (first < data.length && Math.abs(data[first]) < 0.02) { first++; }
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    chans.push(buf.getChannelData(c).slice(first));
  }
  return {
    numberOfChannels: buf.numberOfChannels,
    sampleRate: buf.sampleRate,
    length: chans[0].length,
    getChannelData: (i) => chans[i]
  };
}

// ------------------------------------------------- the compiled extension host

const posted = [];
const logged = [];
let webviewOnMessage = null;

const vscodeStub = {
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString: () => 'r:' + path.join(base.fsPath, ...p) }),
    file: (f) => ({ fsPath: f })
  },
  ViewColumn: { Active: 1, Beside: 2 },
  workspace: { workspaceFolders: [{ uri: { fsPath: ROOT } }], openTextDocument: async (f) => ({ f }),
    getConfiguration: () => ({ get: (k, d) => d }),          // defaults: smart suggestions ON
    onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {
    createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
        set html(v) { this._h = v; }, get html() { return this._h; },
        postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
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
  // The real listener holds a claimed port in the running IDE; this harness
  // drives the webview channel directly and has no business binding a port.
  if (req === 'http') { return { createServer: () => ({ on() {}, listen: (p, h, cb) => cb && cb(), close() {} }) }; }
  return realLoad.apply(this, arguments);
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));

/** Post audio at the extension the way the webview does, and wait for the reply. */
function transcribeViaExtension(wavBytes) {
  const before = posted.length;
  webviewOnMessage({ type: 'transcribe', wav: YieldWav.toBase64(wavBytes) });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const msg = posted.slice(before).find((m) => m.type === 'transcript' || m.type === 'voiceFailed');
      if (msg) {
        clearInterval(poll);
        msg.type === 'transcript' ? resolve({ text: msg.text, ms: Date.now() - t0 })
                                  : reject(new Error(msg.reason));
      } else if (Date.now() - t0 > 180000) {
        clearInterval(poll); reject(new Error('timed out waiting for a transcript'));
      }
    }, 50);
  });
}

// ------------------------------------------------------------------ the checks

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
function report(name, value) { console.log(`      ${name}: ${value}`); }

const SPOKEN = 'Remember that the deploy pipeline runs on the staging branch first.';
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

(async () => {
  ext.activate({
    extensionUri: { fsPath: ROOT },
    globalStorageUri: { fsPath: MODEL_CACHE },
    subscriptions: [],
    workspaceState: { get: (k, d) => d, update: async () => {} },
    extension: { packageJSON: { version: 'test' } }
  });
  await vscodeStub._cmds['yield.open']();
  webviewOnMessage({ type: 'ready' });

  console.log('\n=== 1. conditioning: 48 kHz stereo -> 16 kHz mono WAV ===');
  const src = readWav(path.join(FIXTURES, 'src48.wav'));
  report('source', `${src.numberOfChannels}ch ${src.sampleRate}Hz ${(src.length / src.sampleRate).toFixed(2)}s`);
  const wav = YieldWav.fromAudioBuffer(src);
  const h = wavHeader(wav);
  check('emits RIFF/WAVE', [h.riff, h.wave], ['RIFF', 'WAVE']);
  check('emits 16 kHz (the field nodejs-whisper checks, so ffmpeg is skipped)', h.sampleRate, 16000);
  check('emits mono 16-bit', [h.channels, h.bits], [1, 16]);
  check('declared data length matches the buffer', h.dataBytes, wav.length - 44);
  check('0.5s of lead silence is present', leadingSilentSamples(wav) >= 8000, true);

  console.log('\n=== 2. pipeline: audio -> compiled extension -> transcript ===');
  const first = await transcribeViaExtension(wav);
  report('transcript', JSON.stringify(first.text));
  report('COLD latency (first transcription of the session)', `${(first.ms / 1000).toFixed(2)}s`);
  check('transcript matches what was spoken', norm(first.text), norm(SPOKEN));

  const second = await transcribeViaExtension(wav);
  report('WARM latency (second call, same session)', `${(second.ms / 1000).toFixed(2)}s`);
  report('audio duration', `${(src.length / src.sampleRate).toFixed(2)}s`);
  check('warm run is identical', norm(second.text), norm(first.text));

  console.log('\n=== 3. the 0.5s padding fixes first-word truncation ===');
  // known.wav is the stage-1 clip that DEMONSTRABLY ate its first word. Using a
  // clip where the bug reproduces is the whole point: on a clip that never
  // truncates, a padding test passes for free and proves nothing.
  const trunc = readWav(path.join(FIXTURES, 'known.wav'));
  const SPOKEN2 = 'The quick brown fox jumps over the lazy dog. Yield turns agent wait time into context.';
  const unpadded = YieldWav.fromAudioBuffer(trunc, 0);
  const padded = YieldWav.fromAudioBuffer(trunc, 0.5);
  check('unpadded really has no lead silence', leadingSilentSamples(unpadded) < 800, true);
  check('padded really has 0.5s of lead silence', leadingSilentSamples(padded) >= 8000, true);

  const noPad = await transcribeViaExtension(unpadded);
  const withPad = await transcribeViaExtension(padded);
  // EXACT first word. Word-recall scoring hid this exact failure in stage 1 by
  // matching the later "the" in "over the lazy dog".
  const firstWord = (x) => norm(x).split(' ')[0] || '(empty)';
  report('spoken           ', JSON.stringify(SPOKEN2));
  report('unpadded (0.0s)  ', JSON.stringify(noPad.text));
  report('padded   (0.5s)  ', JSON.stringify(withPad.text));
  check('WITHOUT padding the first word is lost', firstWord(noPad.text), 'quick');
  check('WITH padding the first word survives', firstWord(withPad.text), 'the');

  console.log('\n=== 4. platform fallback (mic must degrade, never crash) ===');
  const { checkVoiceSupport } = require(path.join(ROOT, 'out', 'whisper.js'));
  const cases = [
    ['linux x64', 'linux', 'x64'],
    ['win32 x64', 'win32', 'x64'],
    ['darwin x64 (Intel Mac)', 'darwin', 'x64'],
    ['darwin arm64 (supported)', 'darwin', 'arm64']
  ];
  for (const [label, plat, arch] of cases) {
    const r = checkVoiceSupport(ROOT, plat, arch);
    report(label, r.ok ? 'ok:true (mic enabled)' : `ok:false — "${r.reason}"`);
    results.push(label.includes('supported') ? r.ok === true : r.ok === false);
  }
  check('arm64 macOS is the only supported combination', true, true);
  // and the case where the binary was never staged into the install
  const missing = checkVoiceSupport('/nonexistent/install', 'darwin', 'arm64');
  check('missing binary degrades instead of throwing', missing.ok === false && /missing/i.test(missing.reason), true);

  console.log('\n=== 5. the extension never auto-saves a transcript ===');
  const notesBefore = posted.filter((m) => m.type === 'saved').length;
  check('no save was triggered by any transcription', notesBefore, 0);

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message); process.exit(1); });
