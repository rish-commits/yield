// Runs every suite in this directory against the COMPILED build.
//
// Compile first: `npm run compile`. These drive `out/*.js`, not the TypeScript,
// because the thing that ships is what is worth testing.
//
// Skipped unless asked for:
//   llm-tone.js      — spends real money on real model calls (--tone to include)
//   voice-*.js       — need VOICE_ENABLED=true and audio fixtures that are not
//                      in the repo (see README)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const withTone = args.includes('--tone');
const withVoice = args.includes('--voice');

const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && f !== 'run-all.js')
  .filter((f) => (withTone || f !== 'llm-tone.js'))
  .filter((f) => (withVoice || !f.startsWith('voice-') || f === 'voice-off.js'))
  .sort();

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const count = (out.match(/\d+ *\/ *\d+ passed/g) || []).pop() || '';
  const ok = r.status === 0;
  if (!ok) { failed++; }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${f.replace(/\.js$/, '').padEnd(20)} ${count}`);
  if (!ok) {
    const why = out.match(/HARNESS ERROR.*|^FAIL {2}.*/gm) || [];
    why.slice(0, 3).forEach((l) => console.log(`          ${l.trim()}`));
  }
}
console.log(`\n${files.length - failed}/${files.length} suites passed`);
process.exit(failed ? 1 : 0);
