// STAGE 4 — tone, against the REAL model. Ten unprimed cases, raw output.
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');
const os = require('os');
const A = require(path.join(ROOT, 'out', 'ask.js'));

const CTX = `# Project context

Standing instructions for anyone working on this project, human or AI.
Where two entries conflict, the later one wins.

## Commands

- pnpm install, pnpm dev, pnpm test

## Conventions

- TypeScript strict mode, never use any
- prefer named exports over default exports

## Avoid

- never edit anything under generated/

## Notes

- deploy target is Vercel
`;
const TASKS = [
  'Add Redis caching to the product listing endpoint.',
  'Add rate limiting to the public API.',
  'Set up structured logging across the services.',
  'Add a feature flag system so we can dark-launch the new checkout.',
  'Wire up error monitoring so we hear about production exceptions.',
  'Add full-text search over the articles table.',
  'Add internationalisation so the marketing site works in French.',
  'Let users upload profile photos.',
  'Add a websocket channel for live order status.',
  'Move the nightly report generation into a background job queue.'
];
const HEDGES = ['if useful','if it matters','if relevant','might want','maybe','perhaps','possibly','if you like','if that helps'];

(async () => {
  const cwd = await A.neutralCwd(fs.mkdtempSync(path.join(os.tmpdir(), 'tone-')));
  const rows = [];
  for (const task of TASKS) {
    const t0 = Date.now();
    const ask = await A.generateQuestion({ task, store: CTX, cwd, timeoutMs: 20000 });
    rows.push({ task, ask, ms: Date.now() - t0 });
  }
  console.log('RAW OUTPUT\n');
  rows.forEach((r, i) => {
    const t = r.ask.kind === 'question' ? r.ask.text : `<${r.ask.kind}${r.ask.reason ? ': ' + r.ask.reason : ''}>`;
    console.log(`${String(i + 1).padStart(2)}  ${String(t.split(' ').length).padStart(2)}w  ${(r.ms / 1000).toFixed(1)}s  ${t}`);
  });
  const qs = rows.filter((r) => r.ask.kind === 'question').map((r) => r.ask.text);
  const opens = new Set(qs.map((t) => A.OPENINGS.find((o) => t.startsWith(o)) || '(other)'));
  const ends = new Set(qs.map((t) => A.ENDINGS.find((e) => t.toLowerCase().includes(e.toLowerCase())) || '(other)'));
  const words = qs.map((t) => t.split(' ').length).sort((a, b) => a - b);
  console.log('\nSCORING');
  console.log(`  produced a question      ${qs.length}/10`);
  console.log(`  is an OFFER not a question ${qs.filter((t) => !t.trim().endsWith('?')).length}/${qs.length}`);
  console.log(`  starts with a known opening ${qs.filter((t) => A.OPENINGS.some((o) => t.startsWith(o))).length}/${qs.length}`);
  console.log(`  keeps the door open        ${qs.filter((t) => A.ENDINGS.some((e) => t.toLowerCase().includes(e.toLowerCase()))).length}/${qs.length}`);
  console.log(`  NO parentheses             ${qs.filter((t) => !/[()]/.test(t)).length}/${qs.length}`);
  console.log(`  <=1 hedge                  ${qs.filter((t) => HEDGES.filter((h) => t.toLowerCase().includes(h)).length <= 1).length}/${qs.length}`);
  console.log(`  within 10-16 words         ${words.filter((w) => w >= 10 && w <= 16).length}/${qs.length}   range ${words[0]}-${words[words.length - 1]}`);
  console.log(`  distinct openings used     ${opens.size}  ${[...opens].join(' | ')}`);
  console.log(`  distinct endings used      ${ends.size}  ${[...ends].join(' | ')}`);
})();
