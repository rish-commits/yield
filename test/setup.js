// SELF-INSTALLING HOOKS — every state, against the COMPILED build.
//
// The bar: install the extension and start using it. So the interesting cases
// are all the ways someone's machine differs from mine — no Claude Code, no
// folder open, settings that are already theirs, settings that are broken, a
// directory we cannot write.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const H = require(path.join(ROOT, 'out', 'hooks.js'));
const P = require(path.join(ROOT, 'out', 'ports.js'));

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yield-setup-'));
const CLAUDE = '/usr/local/bin/claude';   // stand-in for "Claude Code is present"

// ── the compiled extension, so the panel line is measured not assumed ──────
async function panelStates() {
  const WS = ws();
  const posted = [];
  const logged = [];
  let onMsg = null;
  let hookHandler = null;
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
      showInformationMessage: (m) => { vscodeStub._info.push(m); }
    },
    commands: {
      registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
      executeCommand: async () => {}
    },
    _cmds: {}, _info: []
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
  const lastNote = () => { const r = posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].setupNote : '(no render)'; };

  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(WS, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  await wait(400);
  await vscodeStub._cmds['yield.open']();
  onMsg({ type: 'ready' });
  await wait(300);

  check('hooks appeared on disk with no prompt', fs.existsSync(H.settingsPath(WS)), true);
  check('nothing was announced to the user', vscodeStub._info.length, 0);
  report('panel line', JSON.stringify(lastNote()));
  check('the restart line shows, because we installed this session',
    lastNote(), H.SETUP_COPY['restart-needed']);
  check('the path is in the output for hand-fixing',
    logged.some((l) => /Claude Code settings: /.test(l)), true);

  // the first hook proves the session has them
  hookHandler(
    { method: 'POST', on: (e, c) => { if (e === 'data') { c(Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', cwd: WS }))); } else { c(); } } },
    { writeHead() {}, end() {} });
  await wait(200);
  check('the line disappears the moment a hook fires', lastNote(), '');
  check('and it is recorded once', logged.filter((l) => /first hook received/.test(l)).length, 1);

  // and it never comes back
  hookHandler(
    { method: 'POST', on: (e, c) => { if (e === 'data') { c(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', cwd: WS }))); } else { c(); } } },
    { writeHead() {}, end() {} });
  await wait(200);
  check('it never returns', lastNote(), '');

  // the recovery command DOES speak, because it was asked for
  await vscodeStub._cmds['yield.installHooks']();
  await wait(200);
  report('recovery command said', JSON.stringify(vscodeStub._info[0]));
  check('the recovery command reports back', vscodeStub._info.length, 1);
  check('and says they are already in place', /already in place/.test(vscodeStub._info[0]), true);

  fs.rmSync(WS, { recursive: true, force: true });
}

(async () => {
  console.log('=== 1. a fresh machine: no settings file at all ===');
  let w = ws();
  let port = P.projectPort(w);
  let r = await H.ensureHooks(w, port, { claudePath: CLAUDE });
  report('state', r.state);
  check('hooks were installed', r.installed, true);
  check('and it reports the restart case', r.state, 'restart-needed');
  const written = JSON.parse(fs.readFileSync(H.settingsPath(w), 'utf8'));
  check('both events are hooked', Object.keys(written.hooks).sort(), ['Stop', 'UserPromptSubmit']);
  check('pointed at this project\'s port', P.configuredPorts(written), [port]);
  check('labelled as ours', written.hooks.Stop[0].hooks[0].statusMessage, 'yield');
  report('what was written', JSON.stringify(written.hooks.UserPromptSubmit));

  console.log('\n=== 2. running it twice must not duplicate ===');
  const before = JSON.stringify(written);
  r = await H.ensureHooks(w, port, { claudePath: CLAUDE });
  check('second run reports ok, not another install', [r.state, r.installed], ['ok', false]);
  const after = fs.readFileSync(H.settingsPath(w), 'utf8');
  check('the file was not touched again', JSON.parse(after), JSON.parse(before));
  const counts = H.EVENTS.map((e) => JSON.parse(after).hooks[e]
    .flatMap((g) => g.hooks).filter((h) => h.statusMessage === 'yield').length);
  check('exactly one of ours per event', counts, [1, 1]);

  console.log('\n=== 3. the user already has their own hooks ===');
  w = ws(); port = P.projectPort(w);
  fs.mkdirSync(path.join(w, '.claude'));
  const theirs = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
      Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'notify-send done' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }]
    },
    model: 'opus'
  };
  fs.writeFileSync(H.settingsPath(w), JSON.stringify(theirs, null, 2));
  r = await H.ensureHooks(w, port, { claudePath: CLAUDE });
  const merged = JSON.parse(fs.readFileSync(H.settingsPath(w), 'utf8'));
  check('installed alongside', r.installed, true);
  check('their UserPromptSubmit command survives',
    merged.hooks.UserPromptSubmit.some((g) => g.hooks.some((h) => h.command === 'echo mine')), true);
  check('their Stop command survives',
    merged.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'notify-send done')), true);
  check('their matcher survives', merged.hooks.Stop.find((g) => g.matcher)?.matcher, 'x');
  check('an unrelated event is untouched',
    merged.hooks.PreToolUse[0].hooks[0].command, 'echo pre');
  check('unrelated settings survive', [merged.permissions.allow, merged.model], [['Bash(ls)'], 'opus']);
  check('ours were added too', H.hasOurHooks(merged, port), true);
  check('their groups were not merged into ours', merged.hooks.UserPromptSubmit.length, 2);

  console.log('\n=== 4. the backup ===');
  const backup = H.backupPath(w);
  check('a backup exists', fs.existsSync(backup), true);
  check('and it is exactly what was there before',
    JSON.parse(fs.readFileSync(backup, 'utf8')), theirs);
  // restore it and confirm the original comes back intact
  fs.copyFileSync(backup, H.settingsPath(w));
  check('restoring it returns their file', JSON.parse(fs.readFileSync(H.settingsPath(w), 'utf8')), theirs);

  console.log('\n=== 5. malformed JSON: refuse, never repair ===');
  w = ws(); port = P.projectPort(w);
  fs.mkdirSync(path.join(w, '.claude'));
  const broken = '{ "hooks": { oops not json,,, }';
  fs.writeFileSync(H.settingsPath(w), broken);
  r = await H.ensureHooks(w, port, { claudePath: CLAUDE });
  check('reported as malformed', r.state, 'malformed');
  check('nothing was installed', r.installed, false);
  check('their file is byte-for-byte intact', fs.readFileSync(H.settingsPath(w), 'utf8'), broken);
  check('no backup was written for a file we did not touch', fs.existsSync(H.backupPath(w)), false);
  check('the path is reported so they can fix it', r.path, H.settingsPath(w));

  console.log('\n=== 6. an empty file is not malformed ===');
  w = ws(); port = P.projectPort(w);
  fs.mkdirSync(path.join(w, '.claude'));
  fs.writeFileSync(H.settingsPath(w), '   \n');
  r = await H.ensureHooks(w, port, { claudePath: CLAUDE });
  check('treated as empty and installed into', [r.state, r.installed], ['restart-needed', true]);
  check('valid JSON came out', H.hasOurHooks(JSON.parse(fs.readFileSync(H.settingsPath(w), 'utf8')), port), true);

  console.log('\n=== 7. the honest failures ===');
  r = await H.ensureHooks(undefined, 41800, { claudePath: CLAUDE });
  check('no folder open', r.state, 'no-workspace');
  r = await H.ensureHooks(ws(), 41800, { claudePath: undefined });
  check('Claude Code not installed', r.state, 'no-claude');

  // a directory we cannot write into
  w = ws();
  fs.mkdirSync(path.join(w, '.claude'));
  fs.chmodSync(path.join(w, '.claude'), 0o500);
  r = await H.ensureHooks(w, P.projectPort(w), { claudePath: CLAUDE });
  fs.chmodSync(path.join(w, '.claude'), 0o700);
  check('no write permission', r.state, 'no-permission');
  check('and it says where', typeof r.path, 'string');

  console.log('\n=== 8. the copy for every state ===');
  for (const state of ['ok', 'restart-needed', 'no-claude', 'no-workspace', 'malformed', 'no-permission']) {
    report(state.padEnd(15), JSON.stringify(H.SETUP_COPY[state]));
    results.push(typeof H.SETUP_COPY[state] === 'string');
  }
  check('a healthy install says nothing at all', H.SETUP_COPY.ok, '');
  check('no em-dashes anywhere in the copy',
    Object.values(H.SETUP_COPY).some((c) => c.includes('—')), false);
  // "Claude Code" is the product's name and must be said plainly. The
  // agent-neutral rule is about never calling the AGENT "Claude".
  const bareClaude = Object.values(H.SETUP_COPY)
    .filter((c) => /\bClaude\b(?! Code)/.test(c));
  check('the agent is never called "Claude" on its own', bareClaude, []);
  check('and the product is named plainly where it matters',
    Object.values(H.SETUP_COPY).filter((c) => /Claude Code/.test(c)).length > 0, true);

  console.log('\n=== 9. finding Claude Code across platforms ===');
  const fakeHome = ws();
  check('absent when nothing is anywhere',
    await H.findClaude({ PATH: '/nonexistent' }, fakeHome, 'linux'), undefined);
  fs.mkdirSync(path.join(fakeHome, '.claude'));
  check('~/.claude counts as evidence',
    (await H.findClaude({ PATH: '/nonexistent' }, fakeHome, 'linux')) !== undefined, true);
  const binDir = ws();
  fs.writeFileSync(path.join(binDir, 'claude.cmd'), '');
  check('windows naming is handled',
    (await H.findClaude({ Path: binDir }, ws(), 'win32')) !== undefined, true);
  check('and is not found under posix naming',
    await H.findClaude({ PATH: binDir }, ws(), 'linux'), undefined);
  report('on THIS machine', await H.findClaude());

  console.log('\n=== 10. the panel line, through the COMPILED extension ===');
  await panelStates();

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
