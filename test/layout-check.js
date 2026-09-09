// Real layout measurement in Chrome, against the shipped panel.css and the real
// composer markup lifted out of panel.html. Static CSS assertions cannot answer
// "is it centred at any height" — this can.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.YIELD_TEST_CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium'
].find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
if (!CHROME) {
  console.error('SKIPPED — no Chrome found. Set YIELD_TEST_CHROME to its binary.');
  process.exit(0);
}

// Pull the actual composer out of panel.html so we measure shipped markup.
const html = fs.readFileSync(path.join(ROOT, 'media/panel.html'), 'utf8');
const start = html.indexOf('<div class="composer">');
const end = html.indexOf('<div class="chatfoot">');
// Take through the composer's OWN closing tag. Stripping it silently nests the
// test cards inside one another, and then every card inherits the previous
// card's state — which is how a "before" case picked up the cold-start height.
let composer = html.slice(start, end).replace(/\{\{\w+\}\}/g, '').trimEnd();
const opens = (composer.match(/<div\b/g) || []).length;
const closes = (composer.match(/<\/div>/g) || []).length;
if (opens !== closes) {
  console.error(`composer extraction is unbalanced: ${opens} <div> vs ${closes} </div>`);
  process.exit(1);
}

// The real top bar, and a reconstruction of the pre-change one with the X, so
// the two can be compared rather than argued about.
const topStart = html.indexOf('<div class="cardtop">');
const topEnd = html.indexOf('<div class="centre">');
const cardtopNoX = html.slice(topStart, topEnd).replace(/\{\{\w+\}\}/g, '').trimEnd().replace(/<\/div>\s*$/, '</div>');
const X = '<button class="iconbtn" id="closebtn" type="button" title="close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>';
const cardtop = cardtopNoX.replace('<!-- Persistent brand', X + '<!-- Persistent brand');

const page = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="file://${ROOT}/media/panel.css">
<style>
/* panel.css centres a single card by making body a flex row. This page stacks
   several cards for comparison, so override that or they shrink-wrap side by
   side and every width measurement is nonsense. */
body{margin:0;background:#f4f4f5;display:block !important;padding:0 !important}
.card{width:400px !important;margin:0 0 12px 0 !important}
</style>
<div class="card" id="c1"><div class="chat">${composer}</div></div>
<div class="card coldstart" id="c2"><div class="chat">${composer}</div></div>
<div class="card" id="c3"><div class="chat">${composer}</div></div>
<div class="card" id="c4"><div class="chat">${composer}</div></div>
<div class="card no-voice" id="c5"><div class="chat">${composer}</div></div>
<div class="card" id="t1">${cardtop}</div>
<div class="card no-voice" id="t2">${cardtopNoX}</div>
<pre id="out"></pre>
<script>
function bars(root){ const w=root.querySelector('.wave');
  for(let i=0;i<30;i++){const b=document.createElement('i');b.style.setProperty('--i',i);
    // a mid-height bar, as during recording
    b.style.height='16px'; w.appendChild(b);} }
const res={};
function measure(cardId,label,cls){
  const card=document.getElementById(cardId);
  const comp=card.querySelector('.composer');
  bars(comp);
  comp.className='composer '+cls;
  const cb=comp.getBoundingClientRect();
  const ta=comp.querySelector('textarea').getBoundingClientRect();
  const out={composerH:+cb.height.toFixed(2), textareaH:+ta.height.toFixed(2)};
  // gap between the composer's border box and the textarea, top vs bottom
  out.taTop=+(ta.top-cb.top).toFixed(2);
  out.taBottom=+(cb.bottom-ta.bottom).toFixed(2);
  const probe = cls.indexOf('voice')>=0 ? '.vstop' : '.retry';
  const el=comp.querySelector(cls.indexOf('voice')>=0?'.vstop':'.nt');
  if(el){ const r=el.getBoundingClientRect();
    out.rowTop=+(r.top-cb.top).toFixed(2); out.rowBottom=+(cb.bottom-r.bottom).toFixed(2); }
  const st=comp.querySelector('.vstate');
  if(st){ const r=st.getBoundingClientRect();
    out.labelTop=+(r.top-cb.top).toFixed(2); out.labelBottom=+(cb.bottom-r.bottom).toFixed(2); }
  const wv=comp.querySelector('.wave');
  if(wv){ const r=wv.getBoundingClientRect(); out.waveH=+r.height.toFixed(2);
    out.waveTop=+(r.top-cb.top).toFixed(2); out.waveBottom=+(cb.bottom-r.bottom).toFixed(2); }
  res[label]=out;
}
// Prove the v77 bug was real: revert the textarea to its browser default
// (inline-block, which sits on a line box) and measure the same composer.
(function(){
  const card=document.getElementById('c3'); const comp=card.querySelector('.composer');
  const ta=comp.querySelector('textarea');
  // Reproduce the SHIPPED v77 state exactly: no display declaration at all,
  // i.e. whatever the UA default is. Setting 'inline-block' by hand is not the
  // same thing if the UA default differs.
  ta.style.display='revert';
  const cb=comp.getBoundingClientRect(), tb=ta.getBoundingClientRect();
  res.BEFORE_inline={uaDisplay:getComputedStyle(ta).display,
    composerH:+cb.height.toFixed(2), textareaH:+tb.height.toFixed(2),
    taTop:+(tb.top-cb.top).toFixed(2), taBottom:+(cb.bottom-tb.bottom).toFixed(2)};
})();
// --- composer right-hand padding: two buttons vs one
(function(){
  function pad(id){
    const comp=document.getElementById(id).querySelector('.composer');
    const ta=comp.querySelector('textarea');
    const cs=getComputedStyle(ta);
    const cb=comp.getBoundingClientRect();
    const btns=comp.querySelector('.cbtns').getBoundingClientRect();
    const vis=[...comp.querySelectorAll('.cbtns button')].filter(b=>getComputedStyle(b).display!=='none');
    // where the text can actually run to, vs where the button column starts
    const textRight = cb.right - parseFloat(cs.paddingRight) - 1;
    return {raw:{compW:+cb.width.toFixed(1), btnsW:+btns.width.toFixed(1), btnsLeftAbs:+btns.left.toFixed(1), compLeftAbs:+cb.left.toFixed(1)},
      paddingRight:cs.paddingRight, visibleButtons:vis.length,
      buttonColumnLeft:+(btns.left-cb.left).toFixed(1),
      textStopsAt:+(textRight-cb.left).toFixed(1),
      clearance:+(btns.left-textRight).toFixed(1)};
  }
  res.composer_withMic=pad('c4');
  res.composer_noMic=pad('c5');
})();
// --- top bar: does removing the X leave a gap?
(function(){
  function bar(id){
    const top=document.getElementById(id).querySelector('.cardtop');
    const tb=top.getBoundingClientRect();
    const btns=[...top.querySelectorAll('.iconbtn')];
    const last=btns[btns.length-1].getBoundingClientRect();
    const chip=top.querySelector('.statuschip').getBoundingClientRect();
    const icon=btns[btns.length-1].querySelector('svg').getBoundingClientRect();
    const dot=top.querySelector('.sdot').getBoundingClientRect();
    return {buttons:btns.length,
      gapAfterLastButton:+(tb.right-last.right).toFixed(1),
      iconInsetFromRight:+(tb.right-icon.right).toFixed(1),
      dotInsetFromLeft:+(dot.left-tb.left).toFixed(1),
      chipLeft:+(chip.left-tb.left).toFixed(1)};
  }
  res.topbar_withX=bar('t1');
  res.topbar_noX=bar('t2');
})();
measure('c1','normal_voice','voice');
measure('c2','coldstart_voice','voice');
document.getElementById('out').textContent='@@'+JSON.stringify(res)+'@@';
</script>`;

const tmp = path.join(os.tmpdir(), '_layout.html');
fs.writeFileSync(tmp, page);
const dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=3000', '--dump-dom', 'file://' + tmp], { encoding: 'utf8', maxBuffer: 20e6 });
fs.rmSync(tmp, { force: true });

const m = /@@(.*?)@@/s.exec(dom);
if (!m) { console.error('no measurement returned'); process.exit(1); }
const r = JSON.parse(m[1]);

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);

const before = r.BEFORE_inline; delete r.BEFORE_inline;
const cw = r.composer_withMic, cn = r.composer_noMic;
delete r.composer_withMic; delete r.composer_noMic;
const tw = r.topbar_withX, tn = r.topbar_noX;
delete r.topbar_withX; delete r.topbar_noX;

console.log('\n--- composer right padding: two buttons vs one ---');
console.log(`      RAW with: ${JSON.stringify(cw.raw)}`);
console.log(`      RAW no  : ${JSON.stringify(cn.raw)}`);
console.log(`      WITH mic (2 buttons): padding-right=${cw.paddingRight}  buttons start at ${cw.buttonColumnLeft}px  text stops at ${cw.textStopsAt}px  clearance=${cw.clearance}px`);
console.log(`      NO mic   (1 button ): padding-right=${cn.paddingRight}  buttons start at ${cn.buttonColumnLeft}px  text stops at ${cn.textStopsAt}px  clearance=${cn.clearance}px`);
console.log(`      text measure regained: ${(cn.textStopsAt - cw.textStopsAt).toFixed(1)}px`);
check('only the send button renders with voice off', cn.visibleButtons, 1);
check('both buttons render with voice on', cw.visibleButtons, 2);
check('clearance to the button column is preserved, not shrunk', Math.abs(cn.clearance - cw.clearance) < 1.5, true);
check('text does not stop short for no reason (measure grew)', cn.textStopsAt > cw.textStopsAt + 30, true);

console.log('\n--- top bar: with the X vs without ---');
console.log(`      WITH X: ${tw.buttons} buttons  gap after last=${tw.gapAfterLastButton}px  icon inset=${tw.iconInsetFromRight}px  dot inset=${tw.dotInsetFromLeft}px`);
console.log(`      NO   X: ${tn.buttons} buttons  gap after last=${tn.gapAfterLastButton}px  icon inset=${tn.iconInsetFromRight}px  dot inset=${tn.dotInsetFromLeft}px`);
check('the file icon still sits flush right — no gap left behind', tn.gapAfterLastButton, tw.gapAfterLastButton);
check('its optical inset is unchanged', tn.iconInsetFromRight, tw.iconInsetFromRight);
check('left and right insets stay symmetric', Math.abs(tn.dotInsetFromLeft - tn.iconInsetFromRight) < 1, true);
console.log('\n--- the v77 textarea bug, measured both ways ---');
console.log(`      BEFORE (UA default = ${before.uaDisplay}): composer=${before.composerH}px  textarea=${before.textareaH}px  gap above=${before.taTop}  gap below=${before.taBottom}`);
console.log(`      AFTER  (display:block): composer=${r.normal_voice.composerH}px  textarea=${r.normal_voice.textareaH}px  gap above=${r.normal_voice.taTop}  gap below=${r.normal_voice.taBottom}`);
console.log(`      asymmetry removed: ${(before.taBottom - before.taTop).toFixed(2)}px -> ${(r.normal_voice.taBottom - r.normal_voice.taTop).toFixed(2)}px`);
results.push(before.taBottom - before.taTop > 2);
console.log(`${before.taBottom - before.taTop > 2 ? 'PASS' : 'FAIL'}  the bug was real (inline-block left a descender gap below)`);

for (const [k, v] of Object.entries(r)) {
  console.log(`\n--- ${k} (composer ${v.composerH}px) ---`);
  report('textarea box', `h=${v.textareaH}  gap above=${v.taTop}  gap below=${v.taBottom}`);
  report('stop button ', `top=${v.rowTop}  bottom=${v.rowBottom}`);
  report('timer label ', `top=${v.labelTop}  bottom=${v.labelBottom}`);
  report('wave        ', `h=${v.waveH}  top=${v.waveTop}  bottom=${v.waveBottom}`);
  // display:block means the textarea no longer sits on a line box, so the
  // composer's height is exactly the textarea's (plus borders).
  check(`${k}: no descender gap under the textarea (display:block)`, v.taBottom <= v.taTop + 0.5, true);
  check(`${k}: stop button vertically centred`, Math.abs(v.rowTop - v.rowBottom) < 1, true);
  check(`${k}: timer vertically centred`, Math.abs(v.labelTop - v.labelBottom) < 1, true);
  check(`${k}: wave fills the row (stretch, not a fixed box)`, Math.abs(v.waveH - (v.composerH - 2)) < 1.5, true);
  check(`${k}: wave centred`, Math.abs(v.waveTop - v.waveBottom) < 1, true);
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
