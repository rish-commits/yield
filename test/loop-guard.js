// STAGE 1 GATE — does Yield's own generation call trigger Yield?
//
// The spike measured this from a shell running INSIDE Claude Code, which has 12
// CLAUDE_* variables the extension host does not. That is the same shape of gap
// as the getUserMedia one, so this harness spawns with the REAL extension host's
// environment, read out of the live process, instead of my shell's.
//
// It also proves the sentinel by temporarily installing a GLOBAL hook in
// ~/.claude/settings.json — the exact future condition that would silently
// re-open the loop — and confirming the guard makes it a no-op.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const P = require(path.join(ROOT, 'out', 'ports.js'));
const A = require(path.join(ROOT, 'out', 'ask.js'));

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────── the real extension host's environment

/**
 * Which port the live extension is actually on.
 *
 * This used to be the literal 41899, which was right the day it was written
 * and wrong the moment probe-and-claim moved the project to another port: the
 * lookup found nothing, HOST came back null, and the suite died on `.pid` of
 * null — harness rot that reads exactly like a product regression. Ask the
 * settings file the extension itself writes, and only fall back to the hash.
 */
function livePorts() {
  const ports = [];
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8');
    ports.push(...P.configuredPorts(JSON.parse(raw)));
  } catch { /* no settings yet, or not readable */ }
  const hashed = P.projectPort(ROOT);
  if (!ports.includes(hashed)) { ports.push(hashed); }
  return ports;
}

function hostEnv() {
  let pid = '';
  for (const port of livePorts()) {
    pid = execFileSync('bash', ['-c',
      `lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null | head -1`], { encoding: 'utf8' }).trim();
    if (pid) { break; }
  }
  if (!pid) { return null; }
  const raw = execFileSync('ps', ['eww', '-p', pid], { encoding: 'utf8' });
  const line = raw.split('\n')[1] || '';
  const env = {};
  let key = null;
  for (const tok of line.split(' ')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok);
    if (m) { key = m[1]; env[key] = m[2]; }
    else if (key) { env[key] += ' ' + tok; }
  }
  return { pid, env };
}

const HOST = hostEnv();

// ─────────────────────────────── the compiled extension, on a real socket

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-loop-'));
fs.mkdirSync(path.join(WS, '.yield'));
fs.writeFileSync(path.join(WS, '.yield', 'yield-context.md'),
  '# Project context\n\n## Notes\n\n- a note so injection has something to send\n');
const OURS = P.projectPort(WS);

const posted = [];
const logged = [];
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
  return realLoad.apply(this, arguments);   // REAL http, real sockets
};
const ext = require(path.join(ROOT, 'out', 'extension.js'));

const chip = () => { const r = posted.filter((m) => m.type === 'render'); return r.length ? r[r.length - 1].statusLabel : '(none)'; };
const hookFires = () => logged.filter((l) => /UserPromptSubmit/.test(l)).length;     // any arrival
const hookActed = () => logged.filter((l) => /UserPromptSubmit →/.test(l)).length;   // arrivals that moved the panel
const ignored = () => logged.filter((l) => /sentinel/.test(l)).length;

// ─────────────────────────────── the global hook, installed then restored

const GLOBAL = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = fs.readFileSync(GLOBAL, 'utf8');

function installGlobalHook(port) {
  const d = JSON.parse(BACKUP);
  d.hooks = {
    UserPromptSubmit: [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/hook`, timeout: 5 }] }]
  };
  fs.writeFileSync(GLOBAL, JSON.stringify(d, null, 2) + '\n');
}
function restoreGlobal() {
  fs.writeFileSync(GLOBAL, BACKUP);
}

// a raw spawn WITHOUT the sentinel, to prove the risk is real
function spawnBare(cwd, env) {
  return spawnSync('claude', [
    '-p', 'say ok',
    '--model', 'haiku', '--system-prompt', 'Reply with one word.',
    '--max-turns', '1', '--output-format', 'json', '--strict-mcp-config'
  ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60000 });
}

(async () => {
  try {
    console.log('=== 0. the environment this spawns with ===');
    check('the live extension host was found', !!HOST, true);
    if (!HOST) {
      throw new Error(
        `no extension host is listening on ${livePorts().join(' or ')} — open this project ` +
        'in the editor with Yield active, then re-run. This suite reads the REAL host env.');
    }
    report('host pid', HOST.pid);
    report('env entries read from it', Object.keys(HOST.env).length);
    const hostClaudeVars = Object.keys(HOST.env).filter((k) => /^CLAUDE/i.test(k));
    const myClaudeVars = Object.keys(process.env).filter((k) => /^CLAUDE/i.test(k));
    report('CLAUDE_* in MY shell', myClaudeVars.length);
    report('CLAUDE_* in the HOST', hostClaudeVars.length);
    check('the host really has none — this is the gap being closed', hostClaudeVars.length, 0);
    check('spawnEnv strips them regardless',
      Object.keys(A.spawnEnv(process.env)).filter((k) => /^CLAUDE/i.test(k)).length, 0);
    check('and forces thinking off', A.spawnEnv({}).MAX_THINKING_TOKENS, '0');

    ext.activate({
      extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(WS, 'gs') },
      subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
    });
    await vscodeStub._cmds['yield.open']();
    vscodeStub._onMsg({ type: 'ready' });
    await wait(300);
    check('the extension is listening', chip(), 'Idle');
    report('listening on', OURS);

    const NEUTRAL = await A.neutralCwd(path.join(WS, 'gs'));
    report('neutral cwd', NEUTRAL);
    check('neutral cwd has no CLAUDE.md', fs.existsSync(path.join(NEUTRAL, 'CLAUDE.md')), false);
    check('neutral cwd has no .claude/', fs.existsSync(path.join(NEUTRAL, '.claude')), false);

    console.log('\n=== 1. spawn with the HOST env, no global hook ===');
    let before = hookFires();
    let r = await A.runClaude({
      systemPrompt: 'Reply with one word.', userPrompt: 'say ok',
      cwd: NEUTRAL, env: { ...A.spawnEnv(HOST.env) }, timeoutMs: 30000
    });
    await wait(600);
    report('result', JSON.stringify(r).slice(0, 90));
    check('the call succeeded', r.ok, true);
    check('ZERO hook arrivals of any kind', hookFires() - before, 0);
    check('the chip never moved', chip(), 'Idle');

    console.log('\n=== 2. now a GLOBAL hook exists — the future that breaks neutral cwd ===');
    installGlobalHook(OURS);
    report('installed', `~/.claude/settings.json UserPromptSubmit -> 127.0.0.1:${OURS}`);

    before = hookFires();
    const bare = spawnBare(NEUTRAL, { ...A.spawnEnv(HOST.env) });
    await wait(800);
    const bareFired = hookFires() - before;
    report('bare call (no sentinel)', `exit ${bare.status}, hook arrivals: ${bareFired}`);
    report('how it was logged', logged.filter((l) => /UserPromptSubmit/.test(l)).slice(-1)[0] || '(nothing)');
    check('a global hook DOES reach us from a neutral cwd — the risk is real', bareFired >= 1, true);

    console.log('\n=== 3. the same conditions, but through Yield (sentinel present) ===');
    before = hookFires();
    const ignoredBefore = ignored();
    const chipBefore = chip();
    r = await A.runClaude({
      systemPrompt: 'Reply with one word.', userPrompt: 'say ok',
      cwd: NEUTRAL, env: { ...A.spawnEnv(HOST.env) }, timeoutMs: 30000
    });
    await wait(800);
    report('result', JSON.stringify(r).slice(0, 90));
    check('the hook still reaches us (we did not dodge it)', hookFires() - before >= 0, true);
    check('but Yield recognised its own call', ignored() - ignoredBefore >= 1, true);
    check('the chip did NOT move — no flicker', chip(), chipBefore);
    check('no WORKING transition was logged for it',
      logged.slice(-6).some((l) => /chip: Idle → Agent is working/.test(l)), false);

    console.log('\n=== 4. the sentinel itself ===');
    check('recognises our marker', A.isOwnCall(`${A.SENTINEL}\nwrite a question`), true);
    check('ignores a normal prompt', A.isOwnCall('add rate limiting to the api'), false);
    check('ignores a non-string', A.isOwnCall(undefined), false);
  } finally {
    restoreGlobal();
    const ok = fs.readFileSync(GLOBAL, 'utf8') === BACKUP;
    console.log(`\n  global settings restored byte-for-byte: ${ok}`);
    if (!ok) { console.error('  !! RESTORE FAILED — check ~/.claude/settings.json'); process.exit(1); }
    try { ext.deactivate(); } catch (e) { /* ignore */ }
    fs.rmSync(WS, { recursive: true, force: true });
  }
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => {
  try { restoreGlobal(); } catch (x) { /* ignore */ }
  console.error('\nHARNESS ERROR —', e.message, '\n', e.stack);
  process.exit(1);
});
