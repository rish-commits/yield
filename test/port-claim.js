// PROBE-AND-CLAIM, on real sockets, against the COMPILED build.
//
// The thing this must prove: two projects whose paths collide BOTH work at the
// same time. And the invariant underneath it — the port written into a
// project's settings is always the port that window actually holds.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'out', 'ports.js'));
const H = require(path.join(ROOT, 'out', 'hooks.js'));

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two real paths that genuinely hash to the same port. */
function collidingPair() {
  const words = ['api', 'web', 'app', 'site', 'client', 'server', 'tools', 'scratch', 'test',
    'tmp', 'demo', 'poc', 'notes', 'docs', 'lib', 'core', 'ui', 'admin', 'bot', 'data',
    'one', 'two', 'three', 'x', 'y', 'z', 'alpha', 'beta', 'gamma', 'delta'];
  const by = new Map();
  const pairs = [];
  for (const a of words) {
    for (const b of words) {
      for (const c of words) {
        const p = path.join(os.tmpdir(), 'yc', a, b, c);
        const q = P.projectPort(p);
        if (!by.has(q)) { by.set(q, []); }
        by.get(q).push(p);
        if (by.get(q).length === 2) { pairs.push([q, by.get(q).slice()]); }
      }
    }
  }
  return pairs;
}

/** Free RIGHT NOW — asked by binding, the same way ports.ts asks. */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

/**
 * The first colliding pair whose port nothing else is holding.
 *
 * Taking the first pair unconditionally used to hand back whatever port the
 * word list happened to hash to, and on this machine that was the port the
 * REAL extension had claimed — so the suite died with EADDRINUSE against a
 * perfectly healthy build. The harness must never fight the live editor.
 */
async function freeCollidingPair() {
  for (const [port, paths] of collidingPair()) {
    if (await portFree(port)) { return paths; }
    console.log(`      (skipping port ${port}: something is already listening on it)`);
  }
  throw new Error('no colliding pair whose port is free');
}

function makeWindow(root) {
  const posted = [];
  const logged = [];
  const store = new Map();
  const v = {
    Uri: { joinPath: (b, ...p) => ({ fsPath: path.join(b.fsPath, ...p), toString: () => 'r:' + path.join(b.fsPath, ...p) }), file: (f) => ({ fsPath: f }) },
    ViewColumn: { Active: 1, Beside: 2 },
    workspace: {
      workspaceFolders: root ? [{ uri: { fsPath: root } }] : undefined,
      openTextDocument: async (f) => ({ f }),
      getConfiguration: () => ({ get: (k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
      createOutputChannel: () => ({ appendLine: (l) => logged.push(l), show() {}, dispose() {} }),
      createWebviewPanel: () => ({
        webview: {
          cspSource: 'r:', asWebviewUri: (u) => ({ toString: () => 'r:' + u.fsPath }),
          set html(x) { this._h = x; }, get html() { return this._h; },
          postMessage: (m) => { posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (cb) => { v._onMsg = cb; return { dispose() {} }; }
        },
        reveal() {}, dispose() {}, onDidDispose: () => ({ dispose() {} }), viewColumn: 1
      }),
      showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}, showInformationMessage() {}
    },
    commands: { registerCommand: (id, fn) => { v._cmds[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
    _cmds: {}, _onMsg: null, _posted: posted, _logged: logged, _store: store,
    _ctx: {
      extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(root || os.tmpdir(), 'gs') },
      subscriptions: [],
      workspaceState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, val) => { store.set(k, val); } },
      extension: { packageJSON: { version: 'test' } }
    }
  };
  return v;
}

function loadExt(v) {
  const rl = Module._load;
  Module._load = function (r) { if (r === 'vscode') { return v; } return rl.apply(this, arguments); };
  delete require.cache[require.resolve(path.join(ROOT, 'out', 'extension.js'))];
  const ext = require(path.join(ROOT, 'out', 'extension.js'));
  Module._load = rl;
  return ext;
}

const post = (port, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let s = ''; x.on('data', (c) => s += c); x.on('end', () => res(s)); });
  r.on('error', rej); r.end(d);
});

const chip = (v) => { const r = v._posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].statusLabel : '(none)'; };
const line = (v) => { const r = v._posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].setupNote : '(none)'; };
const listeningPort = (v) => {
  const l = v._logged.find((x) => /listening on http/.test(x));
  const m = l && /127\.0\.0\.1:(\d+)/.exec(l);
  return m ? Number(m[1]) : undefined;
};
const settingsPort = (root) => P.configuredPorts(JSON.parse(fs.readFileSync(H.settingsPath(root), 'utf8')))[0];

async function openWindow(root) {
  const v = makeWindow(root);
  const ext = loadExt(v);
  ext.activate(v._ctx);
  await wait(500);
  await v._cmds['yield.open']();
  v._onMsg({ type: 'ready' });
  await wait(400);
  return { v, ext };
}

(async () => {
  console.log('=== 0. the band and the legacy port ===');
  report('band', `${P.PORT_BASE}-${P.PORT_BASE + P.PORT_SPAN - 1} (${P.PORT_SPAN} ports)`);
  check('the range is 1000 wide', P.PORT_SPAN, 1000);
  check('LEGACY_PORT is gone from ports.js', 'LEGACY_PORT' in P, false);
  const srcs = ['src/ports.ts', 'src/extension.ts', 'src/hooks.ts', 'src/ask.ts']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  check('41777 appears nowhere in the source', /41777/.test(srcs), false);
  check('LEGACY_PORT appears nowhere in the source', /LEGACY_PORT/.test(srcs), false);
  const extSrc = fs.readFileSync(path.join(ROOT, 'src/extension.ts'), 'utf8');
  check('exactly one retry timer remains', (extSrc.match(/setTimeout\(\(\) => \{ void startListening/g) || []).length, 1);

  const pair = await freeCollidingPair();
  const [A, B] = pair;
  for (const w of [A, B]) {
    fs.rmSync(w, { recursive: true, force: true });
    fs.mkdirSync(path.join(w, '.yield'), { recursive: true });
    fs.writeFileSync(path.join(w, '.yield', 'yield-context.md'),
      `# Project context\n\n## Notes\n\n- note from ${path.basename(w)}\n`);
  }
  console.log('\n=== 1. two projects whose paths COLLIDE ===');
  report('both hash to', P.projectPort(A));
  check('they really do collide', P.projectPort(A), P.projectPort(B));

  const wa = await openWindow(A);
  const wb = await openWindow(B);
  // Captured BEFORE any hook fires: a hook reaching us proves the setup works
  // and correctly retires the restart line, so asking afterwards asks too late.
  const bLineAtStart = line(wb.v);

  report('A listening on', listeningPort(wa.v) + '   settings say ' + settingsPort(A));
  report('B listening on', listeningPort(wb.v) + '   settings say ' + settingsPort(B));

  check('A claimed the preferred port', listeningPort(wa.v), P.projectPort(A));
  check('B claimed a DIFFERENT one rather than waiting', listeningPort(wb.v) !== listeningPort(wa.v), true);
  check('B is not stuck deaf', chip(wb.v), 'Idle');
  check('A is not stuck deaf', chip(wa.v), 'Idle');

  console.log('\n--- THE INVARIANT: settings always name the port actually held ---');
  check('A: settings port === bound port', settingsPort(A), listeningPort(wa.v));
  check('B: settings port === bound port', settingsPort(B), listeningPort(wb.v));

  console.log('\n--- both panels live at the same time ---');
  await post(settingsPort(A), { hook_event_name: 'UserPromptSubmit', prompt: 'work in A', cwd: A });
  await post(settingsPort(B), { hook_event_name: 'UserPromptSubmit', prompt: 'work in B', cwd: B });

  await wait(400);
  check('A reacted to its own prompt', chip(wa.v), 'Agent is working');
  check('B reacted to its own prompt', chip(wb.v), 'Agent is working');

  console.log('\n--- and each still ignores the other project ---');
  const chipABefore = chip(wa.v);
  await post(settingsPort(A), { hook_event_name: 'UserPromptSubmit', prompt: 'not yours', cwd: B });
  await wait(300);
  check('a foreign cwd is still rejected',
    wa.v._logged.some((l) => /not this window's project/.test(l)), true);

  console.log('\n=== 2. B told its project to restart, because its port moved ===');
  report('B panel line at startup', JSON.stringify(bLineAtStart));
  check('B shows the existing restart copy, not new invented copy',
    bLineAtStart, H.SETUP_COPY['restart-needed']);
  report('B panel line after a hook arrived', JSON.stringify(line(wb.v)));
  check('and it retires once a hook proves it works', line(wb.v), '');

  console.log('\n=== 3. notes save in every window, hearing or not ===');
  wb.v._onMsg({ type: 'note', text: 'saved from the second window' });
  await wait(300);
  check('B saved its note',
    fs.readFileSync(path.join(B, '.yield', 'yield-context.md'), 'utf8').includes('saved from the second window'), true);

  const rememberedB = wb.v._store.get('yield.claimedPort');
  report('B remembered', rememberedB);
  check('the claimed port was remembered', rememberedB, listeningPort(wb.v));

  wa.ext.deactivate(); wb.ext.deactivate();
  await wait(200);

  console.log('\n=== 4. relaunch: a project gets its port back ===');
  const wb2 = makeWindow(B);
  wb2._store.set('yield.claimedPort', rememberedB);
  const ext2 = loadExt(wb2);
  ext2.activate(wb2._ctx);
  await wait(500);
  await wb2._cmds['yield.open']();
  wb2._onMsg({ type: 'ready' });
  await wait(300);
  check('same port as last time', listeningPort(wb2), rememberedB);
  check('settings still agree', settingsPort(B), listeningPort(wb2));
  ext2.deactivate();
  await wait(200);

  console.log('\n=== 5. the remembered port is taken by something else ===');
  const squatter = http.createServer((q, r) => { r.writeHead(200); r.end('{}'); });
  await new Promise((r) => squatter.listen(rememberedB, '127.0.0.1', r));
  const wb3 = makeWindow(B);
  wb3._store.set('yield.claimedPort', rememberedB);
  const ext3 = loadExt(wb3);
  ext3.activate(wb3._ctx);
  await wait(600);
  await wb3._cmds['yield.open']();
  wb3._onMsg({ type: 'ready' });
  await wait(400);
  report('moved to', listeningPort(wb3));
  check('it probed past the squatter', listeningPort(wb3) !== rememberedB, true);
  check('and rewrote its settings to match', settingsPort(B), listeningPort(wb3));
  check('and asks for the restart that needs', line(wb3), H.SETUP_COPY['restart-needed']);
  ext3.deactivate();
  await new Promise((r) => squatter.close(r));
  await wait(200);

  console.log('\n=== 6. EVERY port taken: an end state, not a spin ===');
  const hogs = [];
  const start = P.projectPort(A);
  for (let i = 0; i < P.PROBE_LIMIT + 2; i++) {
    const port = P.PORT_BASE + ((start - P.PORT_BASE + i) % P.PORT_SPAN);
    const s = http.createServer(() => {});
    // A failed listen emits 'error' on the SERVER; it does not reject the
    // promise, so the old `.catch()` caught nothing and an unhandled 'error'
    // took the whole suite down the moment one port in the band was already
    // held — by the live editor, most often. Not being able to hog a port is
    // fine here: the point is only that nothing is left free for the window
    // under test.
    await new Promise((r) => { s.once('error', () => r()); s.listen(port, '127.0.0.1', r); });
    hogs.push(s);
  }
  const wa2 = makeWindow(A);
  const ext4 = loadExt(wa2);
  ext4.activate(wa2._ctx);
  await wait(800);
  await wa2._cmds['yield.open']();
  wa2._onMsg({ type: 'ready' });
  await wait(400);
  check('it did not bind', listeningPort(wa2), undefined);
  check('the chip says it cannot hear', chip(wa2), 'Not hearing the agent');
  report('while retrying, the line is', JSON.stringify(line(wa2)));
  check('and it is bounded, not endless',
    wa2._logged.some((l) => /attempt \d+ of \d+/.test(l)), true);

  // notes must still save with no listener at all
  wa2._onMsg({ type: 'note', text: 'saved with no port at all' });
  await wait(300);
  check('NOTES STILL SAVE with no listener',
    fs.readFileSync(path.join(A, '.yield', 'yield-context.md'), 'utf8').includes('saved with no port at all'), true);

  // let the bounded retries run out
  report('waiting for the retry bound to expire', '~25s');
  await wait(26000);
  report('final line', JSON.stringify(line(wa2)));
  check('it reaches a terminal state with a way out', line(wa2), H.SETUP_COPY['no-port']);
  check('and said it gave up', wa2._logged.some((l) => /gave up claiming a port/.test(l)), true);
  check('the extension is still responsive', typeof wa2._onMsg, 'function');
  wa2._onMsg({ type: 'note', text: 'still saving after giving up' });
  await wait(300);
  check('and STILL saves notes after giving up',
    fs.readFileSync(path.join(A, '.yield', 'yield-context.md'), 'utf8').includes('still saving after giving up'), true);

  ext4.deactivate();
  for (const s of hogs) { try { s.close(); } catch { /* not listening */ } }
  for (const w of [A, B]) { fs.rmSync(w, { recursive: true, force: true }); }

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
