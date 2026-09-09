// The scrolling stack, driven in REAL Chrome against the shipped panel.html,
// panel.css and panel.js. Scroll position, auto-pin, the pill and the
// scroll-bound dissolve are all things a DOM stub cannot answer — they need a
// real layout and a real scroller.
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

let html = fs.readFileSync(path.join(ROOT, 'media/panel.html'), 'utf8');
// strip the CSP and the extension's own asset wiring; point at the real files
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
html = html.replace(/<link rel="stylesheet" href="\{\{styleUri\}\}">/,
  `<link rel="stylesheet" href="file://${ROOT}/media/panel.css">`);
html = html.replace(/<script nonce="\{\{nonce\}\}" src="\{\{wavUri\}\}"><\/script>/,
  `<script src="file://${ROOT}/media/wav.js"></script>`);
html = html.replace(/<script nonce="\{\{nonce\}\}" src="\{\{scriptUri\}\}"><\/script>/,
  `<script>window.__posted=[];window.acquireVsCodeApi=function(){return{postMessage:function(m){window.__posted.push(m);}};};</script>
   <script src="file://${ROOT}/media/panel.js"></script>`);
html = html.replace(/\{\{cardClass\}\}/, 'card no-voice');
html = html.replace(/\{\{\w+\}\}/g, '');

const DRIVER = `
<pre id="__out"></pre>
<script>
// HARNESS SUBSTITUTION, stated plainly: under --virtual-time-budget no scroll
// ANIMATION advances, and \`scroll-behavior: smooth\` turns even a direct
// scrollTop assignment into an animation — so every pin reads as "never
// scrolled". The page is therefore run with scroll-behavior forced to auto AND
// scrollTo shimmed to land instantly. That lets the test measure WHAT the code
// targets and WHEN it fires, which is the behaviour under test. That smoothness
// is still declared is asserted from the stylesheet instead.
window.__scrollCalls = [];
const _scrollTo = Element.prototype.scrollTo;
Element.prototype.scrollTo = function (o) {
  if (o && typeof o === 'object' && typeof o.top === 'number') {
    this.scrollTop = o.top;
    window.__scrollCalls.push(o.top + '->' + this.scrollTop);
    return;
  }
  return _scrollTo.apply(this, arguments);
};
const R = {};
const stream = document.getElementById('stream');
const inner  = document.getElementById('inner');
const pill   = document.getElementById('newmsg');
const centre = document.querySelector('.centre');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const atBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 8;
// panel.js owns addMsg internally; drive it the way the extension does.
function say(role, text, typed) {
  window.dispatchEvent(new MessageEvent('message', { data:
    role === 'user' ? { type: 'echoUser', text } : { type: 'reply', text } }));
}
(async () => {
  // ---- opening state
  R.headerInStream   = stream.contains(centre);
  R.headerIsFirst    = inner.firstElementChild === centre;
  R.startScrollTop   = stream.scrollTop;
  R.topMaskAtRest    = stream.classList.contains('scrolled');
  R.headerVisible    = centre.getBoundingClientRect().height > 0
                    && centre.getBoundingClientRect().bottom > stream.getBoundingClientRect().top;
  R.pillHiddenAtRest = pill.hidden;
  R.headerFilterAtRest = centre.style.filter || '(none)';

  // ---- fill the stack well past one viewport
  const input = document.getElementById('input');
  for (let i = 0; i < 14; i++) {
    input.value = 'message number ' + i + ' with enough text to take a line or two of the column';
    input.dispatchEvent(new Event('input'));
    document.getElementById('sendbtn').click();
    await wait(30);
    R.trace = (R.trace || []);
    R.trace.push(i + ':top=' + Math.round(stream.scrollTop) + '/max=' + (stream.scrollHeight - stream.clientHeight) + (pill.hidden ? '' : ' PILL'));
  }
  await wait(900);
  R.afterFill = { top: Math.round(stream.scrollTop), h: stream.scrollHeight, ch: stream.clientHeight,
                  max: stream.scrollHeight - stream.clientHeight };
  R.messageCount   = inner.querySelectorAll('.msg').length;
  R.overflows      = stream.scrollHeight > stream.clientHeight + 20;
  R.pinnedAtBottom = atBottom();
  R.headerScrolledAway = centre.getBoundingClientRect().bottom < stream.getBoundingClientRect().top + 4;
  R.topMaskWhenScrolled = stream.classList.contains('scrolled');

  // ---- the dissolve, measured on a real element near the top edge
  const msgs = [...inner.querySelectorAll('.msg')];
  const near = msgs.find(m => {
    const rel = m.offsetTop - stream.scrollTop;
    return rel > -40 && rel < 70;
  });
  R.dissolveApplied = near ? (near.style.filter || '') : '(none found)';
  const far = msgs[msgs.length - 1];
  R.newestIsCrisp = !far.style.filter || far.style.filter === '';

  // ---- scroll up to read history
  // Scroll EVENTS are not delivered under virtual time either, so dispatch the
  // one a real browser would fire. Without it the code never learns the user
  // moved, which is a harness artifact and not the behaviour.
  stream.scrollTop = 0;
  stream.dispatchEvent(new Event('scroll'));
  await wait(400);
  R.scrolledUp = stream.scrollTop < 10;
  // The regression: at the top NOTHING has been scrolled past, so nothing may
  // be blurred — least of all the header the user is looking straight at.
  R.headerFilterAtTop = centre.style.filter || '(none)';
  R.anyBlurAtTop = [...inner.children]
    .map(c => c.style.filter || '')
    .filter(f => f.indexOf('blur(') === 0 && parseFloat(f.slice(5)) > 0.05).length;
  R.headerBackInView = centre.getBoundingClientRect().bottom > stream.getBoundingClientRect().top;
  R.pillStillHidden = pill.hidden;

  // ---- a message arrives while reading history
  const before = stream.scrollTop;
  say('assistant', 'an arrival while the user is reading history');
  await wait(500);
  R.viewDidNotMove = Math.abs(stream.scrollTop - before) < 6;
  R.pillAppeared   = !pill.hidden;

  // ---- click the pill
  pill.click();
  await wait(900);
  R.pillJumpedToBottom = atBottom();
  R.pillDismissed      = pill.hidden;

  // ---- at the bottom, an arrival must auto-pin and never show the pill
  say('assistant', 'an arrival while already at the bottom');
  await wait(900);
  R.autoPinnedAtBottom = atBottom();
  R.pillStayedHidden   = pill.hidden;

  R.smoothDeclared = getComputedStyle(stream).scrollBehavior;
  R.scrollCalls = window.__scrollCalls.length;
  R.scrollSample = window.__scrollCalls.slice(0, 4).concat(window.__scrollCalls.slice(-2));
  R.overflowAnchor = getComputedStyle(inner).overflowAnchor;
  document.getElementById('__out').textContent = '@@' + JSON.stringify(R) + '@@';
})();
</script>`;

function run(extraCss) {
  const page = html.replace('</body>', (extraCss ? `<style>${extraCss}</style>` : '') + DRIVER + '</body>');
  const tmp = path.join(os.tmpdir(), '_stack.html');
  fs.writeFileSync(tmp, page);
  const dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=12000', '--dump-dom', 'file://' + tmp],
    { encoding: 'utf8', maxBuffer: 40e6 });
  fs.rmSync(tmp, { force: true });
  const m = /@@(.*?)@@/s.exec(dom);
  if (!m) { throw new Error('driver produced no result'); }
  return JSON.parse(m[1]);
}

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n        got ${JSON.stringify(actual)}${ok ? '' : `  want ${JSON.stringify(expected)}`}`);
}
const report = (n, v) => console.log(`      ${n}: ${v}`);

const R = run('.stream{scroll-behavior:auto !important}');

console.log('=== 1. the header is part of the column ===');
check('the header lives inside the scroller', R.headerInStream, true);
check('and is the FIRST item in it', R.headerIsFirst, true);
check('every open starts at the top', R.startScrollTop, 0);
check('the header is in view at rest', R.headerVisible, true);
check('no top fade at rest — the opening state is undimmed', R.topMaskAtRest, false);
check('no pill at rest', R.pillHiddenAtRest, true);
check('the header is NOT blurred at rest', R.headerFilterAtRest, '(none)');

console.log('\n=== 2. the stack grows without a cap ===');
report('messages in the column', R.messageCount);
report('after fill', JSON.stringify(R.afterFill));
report('trace', (R.trace || []).join('  '));
report('scrollTo calls intercepted', R.scrollCalls + '  sample: ' + JSON.stringify(R.scrollSample));
check('nothing was capped at 2', R.messageCount > 12, true);
check('the column overflows and scrolls', R.overflows, true);
check('it stayed pinned to the bottom while filling', R.pinnedAtBottom, true);
check('the header scrolled away with the content', R.headerScrolledAway, true);
check('the top fade appears once scrolled', R.topMaskWhenScrolled, true);
// read from the stylesheet, since the harness overrides it in the page
check('scrolling is still declared smooth in the shipped CSS',
  /\.stream\{[^}]*scroll-behavior:smooth/.test(fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8')), true);

console.log('\n=== 3. the scroll-bound dissolve ===');
report('blur on the item at the top edge', R.dissolveApplied);
check('content near the top edge is blurred', /blur\([\d.]+px\)/.test(R.dissolveApplied), true);
check('the newest message stays crisp', R.newestIsCrisp, true);

console.log('\n=== 4. scrolling back to read history ===');
check('scrolled to the top', R.scrolledUp, true);
check('the header is back in view', R.headerBackInView, true);
check('no pill just for scrolling', R.pillStillHidden, true);
report('header filter at the top', R.headerFilterAtTop);
check('the header is NOT blurred at the top', R.headerFilterAtTop, '(none)');
check('nothing at all is blurred at the top', R.anyBlurAtTop, 0);

console.log('\n=== 5. a message arrives while reading history ===');
check('the view was NOT yanked down', R.viewDidNotMove, true);
check('the pill appeared instead', R.pillAppeared, true);
check('clicking it goes to the bottom', R.pillJumpedToBottom, true);
check('and dismisses it', R.pillDismissed, true);

console.log('\n=== 6. at the bottom, behaviour is unchanged ===');
check('an arrival auto-pins as before', R.autoPinnedAtBottom, true);
check('and the pill never appears', R.pillStayedHidden, true);

console.log('\n=== 7. prefers-reduced-motion ===');
// Chrome headless honours the emulated setting via the media query below
const RM2 = (() => {
  const page = html.replace('</body>', '<style>.stream{scroll-behavior:auto !important}</style>' + DRIVER + '</body>');
  const tmp = path.join(os.tmpdir(), '_stack_rm.html');
  fs.writeFileSync(tmp, page);
  const dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox',
    '--force-prefers-reduced-motion', '--virtual-time-budget=12000', '--dump-dom', 'file://' + tmp],
    { encoding: 'utf8', maxBuffer: 40e6 });
  fs.rmSync(tmp, { force: true });
  const m = /@@(.*?)@@/s.exec(dom);
  return m ? JSON.parse(m[1]) : null;
})();
if (RM2) {
  report('blur under reduced motion', JSON.stringify(RM2.dissolveApplied));
  check('the blur dissolve is skipped', /blur/.test(RM2.dissolveApplied), false);
  check('but the stack still works', RM2.messageCount > 12, true);
  check('and the pill still behaves', [RM2.pillAppeared, RM2.pillDismissed], [true, true]);
} else {
  console.log('      (reduced-motion run produced no result)');
  results.push(false);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
