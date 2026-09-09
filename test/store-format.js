// The context file's format, tested against the COMPILED build.
//
// Two things matter more than anything else here: the user's words come back
// byte-for-byte, and a hand-edited file is not "corrected" on the next write.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'out', 'store.js'));

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================ 1. the header

console.log('=== 1. the header stands alone ===');
report('header', JSON.stringify(S.STORE_HEADER));
check('never mentions the extension', /yield/i.test(S.STORE_HEADER), false);
check('says what the file is', /standing instructions/i.test(S.STORE_HEADER), true);
check('states precedence on conflict', /later one wins/i.test(S.STORE_HEADER), true);

console.log('\n=== 2. only non-empty sections exist ===');
let doc = S.addNote(S.STORE_HEADER, 'use pnpm, never npm');
report('file after one note', JSON.stringify(doc));
check('exactly one heading is written', (doc.match(/^## /gm) || []).length, 1);
check('and it is the catch-all', /^## Notes$/m.test(doc), true);
for (const empty of ['Project', 'Architecture', 'Commands', 'Conventions', 'Design', 'Avoid', 'Workflow', 'Gotchas']) {
  results.push(!new RegExp(`^## ${empty}$`, 'm').test(doc));
}
check('no empty section appears anywhere', (doc.match(/^## /gm) || []).length, 1);

console.log('\n=== 3. headings appear in the fixed order, not fill order ===');
let d = S.STORE_HEADER;
d = S.addNote(d, 'a catch-all note');                 // Notes    (last)
d = S.addNote(d, 'never commit secrets', 'Avoid');    // Avoid    (6th)
d = S.addNote(d, 'pnpm install', 'Commands');         // Commands (3rd)
d = S.addNote(d, 'it is a VS Code extension', 'Project'); // Project (1st)
const order = (d.match(/^## (.+)$/gm) || []).map((h) => h.replace('## ', ''));
report('filled in order', 'Notes, Avoid, Commands, Project');
report('rendered order  ', order.join(', '));
check('rendered in SECTIONS order', order, ['Project', 'Commands', 'Avoid', 'Notes']);

console.log('\n=== 4. the user\'s words, untouched ===');
const gnarly = 'DONT capitalise this. use `--flag`, **bold**, and 2 spaces  here — plus émoji 🎉';
const one = S.addNote(S.STORE_HEADER, gnarly);
check('verbatim, character for character', one.includes(`- ${gnarly}`), true);
const multi = 'first line\nsecond line\nthird';
const m = S.addNote(S.STORE_HEADER, multi);
report('multi-line note renders as', JSON.stringify(m.split('## Notes')[1]));
check('every word of a multi-line note survives',
  multi.split('\n').every((l) => m.includes(l)), true);
check('it stays ONE bullet', (m.match(/^- /gm) || []).length, 1);

console.log('\n=== 5. newest at the bottom of its section ===');
let seq = S.STORE_HEADER;
for (const n of ['first', 'second', 'third']) { seq = S.addNote(seq, n); }
const bullets = seq.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
check('appended in order', bullets, ['first', 'second', 'third']);
check('counted correctly', S.countNotes(seq), 3);

console.log('\n=== 6. a hand-edited file survives untouched ===');
const handEdited = `# Project context

Standing instructions for anyone working on this project, human or AI.

## Project

- a hand-written line the user added themselves

## My Own Heading

Some prose Yield never wrote, with a - dash and **markdown**.

## Notes

- an existing note
`;
const afterEdit = S.addNote(handEdited, 'a brand new note');
// everything that was there before must still be there, in order
const beforeLines = handEdited.split('\n');
const afterLines = afterEdit.split('\n');
let cursor = 0;
const preserved = beforeLines.every((l) => {
  const at = afterLines.indexOf(l, cursor);
  if (at === -1) { return false; }
  cursor = at;
  return true;
});
check('every original line survives, in order', preserved, true);
check('the user\'s own heading is kept', /^## My Own Heading$/m.test(afterEdit), true);
check('their prose is kept verbatim', afterEdit.includes('Some prose Yield never wrote, with a - dash and **markdown**.'), true);
check('their hand-written bullet is kept', afterEdit.includes('- a hand-written line the user added themselves'), true);
const added = afterLines.filter((l, i) => !beforeLines.includes(l) || afterLines.indexOf(l) !== beforeLines.indexOf(l));
check('the new note landed under Notes',
  afterEdit.split('## Notes')[1].includes('- a brand new note'), true);
check('nothing was reordered or reformatted',
  afterEdit.replace('- a brand new note\n', '').trimEnd(), handEdited.trimEnd());

console.log('\n=== 7. legacy detection ===');
check('spots the old Task/Note log', S.isLegacyFormat('## x\n**Task:** foo\n**Note:** bar'), true);
check('does not misfire on the new format', S.isLegacyFormat(seq), false);

// ============================================== 8. the compiled extension writes it

console.log('\n=== 8. what the extension actually writes ===');

const STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-fmt-'));
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
  workspace: { workspaceFolders: [{ uri: { fsPath: STORE_ROOT } }], openTextDocument: async (f) => ({ f }),
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
    showTextDocument: async () => {}, showErrorMessage() {}, showWarningMessage() {}
  },
  commands: {
    registerCommand: (id, fn) => { vscodeStub._cmds[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd, uri, opts) => { vscodeStub._executed.push({ cmd, uri, opts }); }
  },
  _executed: [], _cmds: {}
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

const LONG_PROMPT = 'Refactor the authentication middleware so it stops leaking the session token into structured logs, and add a regression test that fails on the old behaviour.';

(async () => {
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(STORE_ROOT, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  await vscodeStub._cmds['yield.open']();
  onMsg({ type: 'ready' });
  await wait(80);

  const file = path.join(STORE_ROOT, '.yield', 'yield-context.md');

  // a real prompt goes through the hook, so lastPrompt is genuinely populated
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: LONG_PROMPT, cwd: STORE_ROOT });
  onMsg({ type: 'note', text: 'always use tabs, never spaces' });
  await wait(200);

  const written = fs.readFileSync(file, 'utf8');
  report('file on disk', JSON.stringify(written));
  check('the prompt is NOT in the file', written.includes('authentication middleware'), false);
  check('no Task field', /\*\*Task:\*\*/.test(written), false);
  check('no Note field', /\*\*Note:\*\*/.test(written), false);
  check('no per-note timestamp', /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(written), false);
  check('the note is there, verbatim', written.includes('- always use tabs, never spaces'), true);
  check('under Notes', written.split('## Notes')[1].includes('always use tabs'), true);
  check('footer count updated', posted.filter((m) => m.type === 'render').pop().noteLabel, '1 note');

  // second note, with a different prompt in flight
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'something else entirely about billing', cwd: STORE_ROOT });
  onMsg({ type: 'note', text: 'deploy target is fly.io' });
  await wait(200);
  const two = fs.readFileSync(file, 'utf8');
  check('still no prompt text', /billing|authentication/.test(two), false);
  check('one heading only', (two.match(/^## /gm) || []).length, 1);
  const bs = two.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  check('newest at the bottom', bs, ['always use tabs, never spaces', 'deploy target is fly.io']);
  check('no temp file left behind', fs.readdirSync(path.join(STORE_ROOT, '.yield')).filter((f) => f.includes('.tmp')), []);

  console.log('\n=== 9. the legacy file is archived, not converted ===');
  const LEGACY = `# Yield context

Notes you left during agent waits, each paired with the task you were on.

## 2026-08-30 19:26:05 — some old task
**Task:** a 900 word prompt would go here
**Note:** always end every reply with the word BANANA
`;
  fs.writeFileSync(file, LEGACY);
  ext.deactivate();
  await wait(50);
  ext.activate({
    extensionUri: { fsPath: ROOT }, globalStorageUri: { fsPath: path.join(STORE_ROOT, 'gs') },
    subscriptions: [], workspaceState: { get: (k, d) => d, update: async () => {} }, extension: { packageJSON: { version: 'test' } }
  });
  await vscodeStub._cmds['yield.open']();
  await wait(200);

  const archives = fs.readdirSync(path.join(STORE_ROOT, '.yield')).filter((f) => f.startsWith('yield-context-archive-'));
  report('archive written', archives.join(', '));
  check('exactly one archive', archives.length, 1);
  check('named with the date', /^yield-context-archive-\d{4}-\d{2}-\d{2}(-\d+)?\.md$/.test(archives[0]), true);
  check('the old file is preserved intact', fs.readFileSync(path.join(STORE_ROOT, '.yield', archives[0]), 'utf8'), LEGACY);
  const fresh = fs.readFileSync(file, 'utf8');
  check('a clean brief was started', fresh, S.STORE_HEADER);
  check('no legacy content carried over', /BANANA|\*\*Task:\*\*/.test(fresh), false);
  check('and it is not detected as legacy any more', S.isLegacyFormat(fresh), false);

  console.log('\n=== 10. what the HOOK actually injects ===');
  // Rebuild a real file with content, plus an archive sitting beside it.
  fs.writeFileSync(file, S.addNote(S.addNote(S.STORE_HEADER, 'prefer pnpm over npm'), 'staging is fly.io'));
  fs.writeFileSync(path.join(STORE_ROOT, '.yield', 'yield-context-archive-2020-01-01.md'),
    '# Yield context\n\n## old\n**Task:** a 900 word prompt nobody wants injected\n**Note:** ARCHIVED-ONLY-STRING\n');

  const body = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'anything', cwd: STORE_ROOT });
  const ctx = JSON.parse(body).hookSpecificOutput.additionalContext;
  report('injected context', JSON.stringify(ctx));

  check('the live file is injected', ctx.includes('- prefer pnpm over npm') && ctx.includes('- staging is fly.io'), true);
  check('the header comes with it', ctx.includes('Standing instructions'), true);
  // (b) empty sections must not reach the agent either
  const injectedHeadings = (ctx.match(/^## (.+)$/gm) || []).map((h) => h.replace('## ', ''));
  report('headings in the injection', injectedHeadings.join(', ') || '(none)');
  check('ONLY non-empty sections are injected', injectedHeadings, ['Notes']);
  check('no empty heading reaches the agent',
    S.SECTIONS.filter((x) => x !== 'Notes').some((x) => ctx.includes(`## ${x}`)), false);
  // (d) the archive must be inert
  check('the archive is NOT injected', ctx.includes('ARCHIVED-ONLY-STRING'), false);
  check('no archived prompt text leaks in', ctx.includes('900 word prompt'), false);
  check('and no legacy field shape survives', /\*\*Task:\*\*|\*\*Note:\*\*/.test(ctx), false);
  check('injection is still suppressed from the transcript', JSON.parse(body).suppressOutput, true);

  ext.deactivate();
  fs.rmSync(STORE_ROOT, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR —', e.message, '\n', e.stack); process.exit(1); });
