// Yield panel — the webview is a renderer. It owns no persistent state: the
// extension derives which of the three states (handoff §2) applies and pushes
// it here. The only thing the webview keeps is the conversation stack, which is
// disposable by design — notes are the product, the chat is the funnel, the
// file is the history.
//
// Phase C scope: the rolling stack (§4). One continuous stack, only the last 2
// live, moving one at a time. Arrival rises and un-blurs; the message pushed
// out of the live pair drifts up, blurs and shrinks. History stays in the DOM
// and is browsed by native smooth scroll behind a both-edge fade mask.
//
// Phase D: the reply itself is composed in the extension (questions.ts) and
// arrives as a `reply` message. The webview only decides WHEN it lands and
// types it out — so swapping the script for a model call changes nothing here.

(function () {
  const vscode = acquireVsCodeApi();

  const card = document.getElementById('card');
  const statusLabel = document.getElementById('statusLabel');
  const qopts = document.getElementById('qopts');
  const qoptTpl = document.getElementById('qopt-tpl');
  const stream = document.getElementById('stream');
  const inner = document.getElementById('inner');
  const input = document.getElementById('input');
  const sendbtn = document.getElementById('sendbtn');
  const ctxbtn = document.getElementById('ctxbtn');
  const openbtn = document.getElementById('openbtn');
  const ctxlabel = document.getElementById('ctxlabel');
  let micbtn = document.getElementById('micbtn');   // removed outright when voice is off
  const newmsg = document.getElementById('newmsg');
  const setupnote = document.getElementById('setupnote');
  const composer = document.querySelector('.composer');
  const wave = document.getElementById('wave');
  const vstate = document.getElementById('vstate');
  const vstop = document.getElementById('vstop');
  const noticetext = document.getElementById('noticetext');
  const retrybtn = document.getElementById('retrybtn');
  const cprog = document.getElementById('cprog');
  const mark = document.querySelector('.markwrap .mark');

  const SAVED_FLASH_MS = 1400;
  const PIN_SLACK = 8;         // px from the bottom that still counts as pinned
  const REPLY_BEAT_MS = 520;   // breath between the user's line and the answer

  let flashTimer;
  let pinTimer;
  let lastSendAt = 0;
  // Which question they took up, if any. Free-typing leaves this null, which is
  // exactly safety behaviour 3: a neutral ack and no re-ask.
  let pendingAskId = null;
  let pinning = false;
  let footerLabel = ctxlabel.textContent;
  let flashing = false;

  // ---- voice (v78 states)
  let voiceEnabled = false;     // pushed by the extension: does the mic exist at all
  let voiceOk = false;          // pushed by the extension: is this machine capable
  let voiceReason = '';
  let recorder = null;
  let chunks = [];
  let recording = false;
  let composerPlaceholder = input.placeholder;
  // ONE MediaStream feeds both the recorder and the analyser. A second
  // getUserMedia would mean a second permission prompt and a second thing to
  // leak, for the same audio we already have.
  let micStream = null;
  let audioCtx = null;
  let analyser = null;
  let freqData = null;
  let rafId = null;
  let timerId = null;
  let secs = 0;
  // The captured audio is RETAINED after a failure so Retry re-transcribes it.
  // The state model's rule is that we never lose what was spoken.
  let lastWav = null;

  // ------------------------------------------------------------ the footer

  function flashFooter(label, isError) {
    clearTimeout(flashTimer);
    flashing = true;
    ctxlabel.textContent = label;
    ctxbtn.classList.toggle('saved', !isError);
    flashTimer = setTimeout(() => {
      flashing = false;
      ctxbtn.classList.remove('saved');
      ctxlabel.textContent = footerLabel; // settles to the NEW count
    }, SAVED_FLASH_MS);
  }

  // ------------------------------------------------------------- rendering

  function applyRender(msg) {
    if (typeof msg.cardClass === 'string') { card.className = msg.cardClass; }
    if (typeof msg.statusLabel === 'string') { statusLabel.textContent = msg.statusLabel; }
    // Handoff §6's label (filename / "1 note" / "N notes") is composed in the
    // extension, same as the reply text — this side just paints what arrives.
    if (typeof msg.noteLabel === 'string') {
      footerLabel = msg.noteLabel;
      // Don't stomp on a Saved flash in flight; it settles to this itself.
      if (!flashing) { ctxlabel.textContent = footerLabel; }
    }
    if (msg.voice && typeof msg.voice.ok === 'boolean') {
      voiceEnabled = msg.voice.enabled !== false;
      voiceOk = msg.voice.ok;
      voiceReason = msg.voice.reason || '';
      applyVoiceAvailability();
    }
    // One line, and only when there is genuinely something to act on. An empty
    // string means the install is healthy, which the panel says by saying nothing.
    if (typeof msg.setupNote === 'string' && setupnote) {
      setupnote.textContent = msg.setupNote;
      setupnote.hidden = msg.setupNote === '';
    }
    renderQuestions(Array.isArray(msg.questions) ? msg.questions : []);
    // The extension's card class is authoritative, so re-assert what the
    // conversation owns after it lands: `chatting` swaps the centred welcome
    // for the bottom-anchored stack.
    if (started) {
      card.classList.remove('coldstart');
      card.classList.add('chatting');
    }
  }

  // Two gates, in order.
  //
  // VOICE_ENABLED (host-side, src/whisper.ts) decides whether the mic EXISTS.
  // With voice off the node is removed outright rather than disabled: a
  // permanently disabled control reads as broken or as coming-soon, and in this
  // shell it is neither — it cannot work here at all. The card also carries
  // `no-voice` from the first painted frame, so nothing flickers before this runs.
  //
  // voiceOk (platform capability) then decides whether an existing mic is
  // usable, wearing the real reason as its tooltip.
  function applyVoiceAvailability() {
    if (!voiceEnabled) {
      if (micbtn && micbtn.parentNode) { micbtn.parentNode.removeChild(micbtn); }
      micbtn = null;
      return;
    }
    if (!micbtn) { return; }
    micbtn.disabled = !voiceOk;
    micbtn.title = voiceOk ? 'Speak instead' : (voiceReason || 'Voice input is not available here');
  }

  // Never more than 2, strictly one line each — the row is nowrap + ellipsis in
  // CSS, so long questions truncate rather than wrap.
  function renderQuestions(list) {
    qopts.textContent = '';
    list.slice(0, 2).forEach((ask) => {
      const row = qoptTpl.content.firstElementChild.cloneNode(true);
      row.querySelector('.qt').textContent = ask.text;
      row.title = ask.text; // the full question, since the row may ellipsize
      row.addEventListener('click', () => askQuestion(ask));
      qopts.appendChild(row);
    });
    // Empty list = nothing worth asking. Silence is a feature (flow §06).
    // Once the conversation starts the rows give way to the stream.
    qopts.classList.toggle('hide', list.length === 0 || started);
  }

  // ------------------------------------------------------ the scrolling stack
  //
  // One continuous column holding the header and every message. Nothing is
  // capped and nothing is removed, so the "dissolve" can no longer be an exit
  // animation — it is written from scroll position instead, which is why it
  // tracks the finger rather than firing once.

  let started = false;
  let stick = true;            // is the view following the bottom?
  const DISSOLVE_BAND = 78;    // px below the top edge where content is crisp again
  const reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function ensureStream() {
    if (started) { return; }
    started = true;
    qopts.classList.add('hide');
    card.classList.remove('coldstart');
    card.classList.add('chatting');   // centred welcome -> header at the top of the column
  }

  function atBottom() {
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight <= PIN_SLACK;
  }

  function addMsg(role, text, type) {
    // Decide BEFORE inserting: appending changes scrollHeight, so asking
    // afterwards would say "not at bottom" for someone who was.
    const wasAtBottom = stick;
    ensureStream();

    const el = document.createElement('div');
    el.className = 'msg ' + role + ' entering';

    if (role === 'assistant') {
      const av = document.createElement('div');
      av.className = 'av';
      const img = document.createElement('img');
      img.src = mark.src;          // same mark as the header, one source
      img.alt = 'Yield';
      av.appendChild(img);
      el.appendChild(av);
    }

    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);
    inner.appendChild(el);
    // Instant messages must have their text BEFORE the pin, or scrollHeight is
    // measured pre-growth and the newest message hangs below the window. Typed
    // ones start empty on purpose — typeInto re-pins on every character.
    if (!type) { body.textContent = text; }   // user messages appear instantly (§4)

    if (wasAtBottom) {
      pin(true);
    } else {
      // Reading history: never yank the view. Offer the jump instead.
      showPill();
    }

    if (type) {
      // Assistant messages type out; the caret blinks while they do.
      setTimeout(function () { typeInto(body, text); }, 120);
    }
    dissolve();
    return el;
  }

  function typeInto(el, text) {
    el.textContent = '';
    el.classList.add('typing');
    let i = 0;
    (function tick() {
      if (i <= text.length) {
        el.textContent = text.slice(0, i);
        i++;
        // Only chase the growth if they are actually watching the bottom.
        if (stick) { pin(false); }
        setTimeout(tick, 14 + Math.random() * 26);   // natural jitter, §4
      } else {
        el.classList.remove('typing');
        if (stick) { pin(false); }
      }
    })();
  }

  // Smooth for arrivals (the stack glides), instant while the typewriter grows
  // so the scroll never chases itself.
  function pin(smooth) {
    pinning = true;
    clearTimeout(pinTimer);
    stream.scrollTo({ top: stream.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    // A smooth scroll emits "not at bottom" events the whole way down; without
    // this we would decide mid-flight that the user had scrolled away.
    pinTimer = setTimeout(function () { pinning = false; onScroll(); }, smooth ? 700 : 60);
  }

  // ------------------------------------------------ the scroll-bound dissolve

  /**
   * Content softens as it passes the top edge instead of animating out of
   * existence. Written straight from scroll position — no transition — so it
   * follows the scroll exactly. Same blur/opacity/scale language the old exit
   * animation used, which is why it still reads as one motion.
   */
  function dissolve() {
    if (reduceMotion) { return; }
    const kids = inner.children;
    // Nothing may dissolve until it has actually been scrolled PAST. Distance
    // from the top edge alone is not enough: at rest the first item sits a few
    // px from that edge, well inside the band, so the header came out blurred
    // on a panel nobody had scrolled. Capping by how far the column has
    // actually moved makes the effect impossible at the top and ramps it in
    // instead of popping.
    const scrolledCap = stream.scrollTop / DISSOLVE_BAND;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const rel = el.offsetTop - stream.scrollTop;
      let p = (DISSOLVE_BAND - rel) / DISSOLVE_BAND;
      if (p > scrolledCap) { p = scrolledCap; }
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      // Ease the ramp instead of running it linearly. Quadratic ease-IN keeps
      // content legible for most of the band and concentrates the dissolve near
      // the edge, which is where it belongs — a linear ramp starts softening
      // text that is still squarely in view.
      p = p * p;
      if (el._p === p) { continue; }             // skip untouched nodes
      el._p = p;
      if (p === 0) {
        el.style.filter = '';
        el.style.opacity = '';
        el.style.transform = '';
      } else {
        el.style.filter = 'blur(' + (p * 7).toFixed(2) + 'px)';
        el.style.opacity = (1 - p * 0.9).toFixed(3);
        el.style.transform = 'scale(' + (1 - p * 0.015).toFixed(4) + ')';
      }
    }
  }

  function onScroll() {
    // The top fade only exists once you have scrolled, so the opening state
    // shows the logo and headlines undimmed.
    stream.classList.toggle('scrolled', stream.scrollTop > 4);
    if (!pinning) { stick = atBottom(); }
    if (stick) { hidePill(); }
    // Straight through, not via requestAnimationFrame: the browser already
    // coalesces scroll events to one per frame, so the rAF hop bought nothing
    // and cost a frame of lag on a dissolve that is supposed to track the
    // finger. Only paint-only properties are written, so no layout is dirtied.
    dissolve();
  }
  stream.addEventListener('scroll', onScroll);

  // ----------------------------------------------------- the new-message pill

  function showPill() { newmsg.hidden = false; }
  function hidePill() { newmsg.hidden = true; }

  newmsg.addEventListener('click', function () {
    hidePill();
    stick = true;
    pin(true);
  });

  // The question becomes a real turn in the stack, typed out, and the composer
  // is handed over for the answer. Taking a question up is engagement, which
  // resets the ignored-round counter behind safety behaviour 2.
  function askQuestion(ask) {
    pendingAskId = ask.id;
    vscode.postMessage({ type: 'engaged' });
    addMsg('assistant', ask.text, true);
    input.placeholder = 'Type your answer…';
    input.focus();
  }

  // -------------------------------------------------------------- composing

  function refreshSend() {
    sendbtn.disabled = input.value.trim().length === 0;
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 88) + 'px';
  }

  function send() {
    const text = input.value.trim();
    if (!text) { return; } // empty save is a no-op (state model §06)
    addMsg('user', text, false);
    lastSendAt = Date.now();
    vscode.postMessage({ type: 'note', text: text, answering: pendingAskId });
    pendingAskId = null;      // answered or not, it is never re-asked
    input.value = '';
    input.style.height = 'auto';
    input.placeholder = 'Answer, or add anything else…';
    refreshSend();
    // The ack comes back as a `reply` message once the note is on disk.
  }

  // Let the user's line settle before answering; the write itself may already
  // have taken most of the beat, so only wait out the remainder.
  function landReply(text) {
    const waited = Date.now() - lastSendAt;
    setTimeout(function () { addMsg('assistant', text, true); },
      Math.max(0, REPLY_BEAT_MS - waited));
  }

  // ------------------------------------------------------------------ voice
  // v78. Every state renders inside the composer; nothing new is added to the
  // layout and nothing resizes. MediaRecorder captures, the Web Audio API
  // decodes, wav.js conditions to the 16 kHz mono WAV whisper.cpp wants — which
  // is what keeps ffmpeg out of the project entirely.

  // 15 log-spaced bins painted outward from the centreline in both directions.
  var HALF = 15;
  var bars = [];
  for (var bi = 0; bi < HALF * 2; bi++) {
    var bar = document.createElement('i');
    bar.style.setProperty('--i', bi);
    wave.appendChild(bar);
    bars.push(bar);
  }

  function paintBars(vals) {
    for (var i = 0; i < HALF; i++) {
      var v = vals[i];
      var h = 2 + v * 30;                        // 2px floor, 32px ceiling
      var left = bars[HALF - 1 - i], right = bars[HALF + i];
      left.style.height = right.style.height = h.toFixed(1) + 'px';
      // Opacity tracks height so quiet bars recede rather than sitting flat.
      left.style.opacity = right.style.opacity = (0.3 + v * 0.7).toFixed(2);
    }
  }

  // Real amplitude off the live stream — never random values.
  function waveFrame() {
    if (!analyser) { return; }
    analyser.getByteFrequencyData(freqData);
    var n = freqData.length, vals = [];
    for (var i = 0; i < HALF; i++) {
      // Log spacing, or the whole thing is bass and barely moves on speech.
      var a = Math.floor(Math.pow(i / HALF, 1.7) * n * 0.55);
      var b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / HALF, 1.7) * n * 0.55));
      var sum = 0;
      for (var j = a; j < b; j++) { sum += freqData[j]; }
      vals.push(Math.min(1, (sum / (b - a)) / 175));
    }
    paintBars(vals);
    rafId = requestAnimationFrame(waveFrame);
  }

  var fmtTime = function (t) { return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

  /** Releases the microphone and the visualiser the instant capture ends, but
   *  KEEPS the AudioContext: finishVoice still needs it to decode what was just
   *  recorded. ONE context, two consumers, in sequence — the analyser while
   *  recording, decodeAudioData after. */
  function releaseMic() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });   // clears the OS mic indicator
      micStream = null;
    }
    analyser = null;
    freqData = null;
  }

  /** The context's own end, once nothing needs it. */
  function closeAudioContext() {
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) { /* already closed */ }
      audioCtx = null;
    }
  }

  /** Everything the audio graph holds, released. */
  function teardownAudio() {
    releaseMic();
    closeAudioContext();
  }

  // ------------------------------------------------------------ voice states

  function clearVoiceChrome() {
    composer.classList.remove('voice', 'settled', 'notice', 'indet');
    retrybtn.style.display = 'none';
    cprog.style.width = '0';
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  /** The single place the composer's voice appearance is decided. */
  function voiceState(state, detail) {
    clearVoiceChrome();

    if (state === 'idle') {
      input.placeholder = composerPlaceholder;
      return;
    }

    if (state === 'recording') {
      composer.classList.add('voice');
      secs = 0;
      vstate.textContent = '0:00';
      vstop.disabled = false;
      timerId = setInterval(function () { secs++; vstate.textContent = fmtTime(secs); }, 1000);
      return;
    }

    if (state === 'transcribing') {
      // Drop recording's inline heights so the scan keyframes can drive them.
      bars.forEach(function (b) { b.style.height = ''; b.style.opacity = ''; });
      composer.classList.add('voice', 'settled');
      vstate.textContent = 'Transcribing…';
      vstop.disabled = true;
      return;
    }

    if (state === 'downloading') {
      composer.classList.add('notice');
      var pct = typeof detail === 'number' ? Math.floor(detail) : 0;
      noticetext.innerHTML = 'Downloading voice model… <b>' + pct + '%</b>';
      cprog.style.width = pct + '%';
      return;
    }

    if (state === 'preparing') {
      // Covers macOS verifying the freshly installed binaries. Shown BEFORE the
      // hang, or the user sits on a mic click that looks dead.
      composer.classList.add('notice', 'indet');
      noticetext.textContent = 'Preparing voice. This happens once after install.';
      return;
    }

    if (state === 'error') {
      composer.classList.add('notice');
      noticetext.innerHTML = (detail ? escapeHtml(detail) : 'Could not transcribe that.') +
        ' <b>Your recording is safe.</b>';
      // Only offer Retry when there is actually audio to retry.
      retrybtn.style.display = lastWav ? 'block' : 'none';
      return;
    }

    // 'reviewing' is just the ordinary light composer with text in it: an
    // editable composer IS the review state, so there is no chrome to add.
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ----------------------------------------------------------- capture flow

  function startVoice() {
    if (recording || !voiceEnabled || !voiceOk) { return; }
    // `navigator.mediaDevices` is absent whenever the surrounding frame is not
    // permitted to capture — which is exactly the case in a VS Code webview,
    // whose iframe never gets `microphone` delegated. Reaching straight for
    // .getUserMedia there throws a TypeError synchronously, BEFORE the promise
    // exists, so the .catch() never attaches and the click dies silently. Check
    // first and say so out loud.
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      vscode.postMessage({ type: 'voiceUnavailable', reason: 'getUserMedia is not available in this webview' });
      voiceState('error', 'This editor does not allow microphone access.');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      micStream = stream;
      recording = true;
      chunks = [];

      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) { chunks.push(e.data); } };
      recorder.onstop = finishVoice;
      recorder.start();

      // The analyser hangs off the SAME stream the recorder is using.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      // Only show the recording surface once capture is genuinely live, so a
      // declined permission never flashes the dark composer.
      voiceState('recording');
      rafId = requestAnimationFrame(waveFrame);
    }).catch(function (err) {
      recording = false;
      teardownAudio();
      voiceState('error', err && err.name === 'NotAllowedError'
        ? 'Microphone permission was declined.'
        : 'Could not start recording.');
    });
  }

  function stopVoice() {
    if (!recording || !recorder) { return; }
    recording = false;
    try { recorder.stop(); } catch (e) { /* already stopped */ }
  }

  // Decode -> mono -> 16 kHz -> WAV (+0.5s lead silence) -> base64 -> host.
  function finishVoice() {
    releaseMic();                          // mic off immediately; the context lives on to decode
    var blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || 'audio/webm' });
    chunks = [];
    if (!blob.size) { closeAudioContext(); voiceState('error', 'Nothing was recorded.'); return; }

    voiceState('transcribing');
    // The SAME context the analyser just used. decodeAudioData resamples to the
    // context rate, which is irrelevant here — wav.js resamples to 16 kHz from
    // whatever it gets.
    if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    var ctx = audioCtx;
    blob.arrayBuffer().then(function (buf) {
      return ctx.decodeAudioData(buf);
    }).then(function (audioBuffer) {
      closeAudioContext();                 // nothing needs it now
      lastWav = window.YieldWav.toBase64(window.YieldWav.fromAudioBuffer(audioBuffer));
      vscode.postMessage({ type: 'transcribe', wav: lastWav });
    }).catch(function () {
      closeAudioContext();
      voiceState('error', 'Could not read the recording.');
    });
  }

  /** Re-runs on the audio ALREADY CAPTURED. Never asks the user to speak again. */
  function retryTranscription() {
    if (!lastWav) { return; }
    voiceState('transcribing');
    vscode.postMessage({ type: 'transcribe', wav: lastWav });
  }

  // The transcript is a DRAFT, not a save. It lands in the composer so the user
  // reviews and edits before committing it (speak -> transcribe -> review ->
  // save). Appends rather than overwrites, so a half-typed note survives.
  function landTranscript(text) {
    voiceState('reviewing');
    var existing = input.value.trim();
    input.value = existing ? existing + ' ' + text : text;
    input.placeholder = composerPlaceholder;
    lastWav = null;                        // it landed; there is nothing to retry
    refreshSend();
    autoGrow();
    input.focus();
    // Caret to the end so the next keystroke continues the sentence.
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* older webview */ }
  }

  if (micbtn) { micbtn.addEventListener('click', startVoice); }
  vstop.addEventListener('click', stopVoice);
  retrybtn.addEventListener('click', retryTranscription);

  // Handoff §6: both doors to the file open the actual file. The archive is a
  // real editor tab, not a view we reimplement.
  function openStore() { vscode.postMessage({ type: 'openStore' }); }
  ctxbtn.addEventListener('click', openStore);
  openbtn.addEventListener('click', openStore);

  input.addEventListener('input', function () { refreshSend(); autoGrow(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendbtn.addEventListener('click', send);

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg) { return; }
    if (msg.type === 'render') { applyRender(msg); return; }
    if (msg.type === 'saved') { flashFooter('Saved', false); return; }
    if (msg.type === 'reply' && typeof msg.text === 'string') { landReply(msg.text); return; }
    // The follow-up suggestion: a SECOND message, after the scripted ack. It
    // arrives whenever the model is done, so the ack has long since landed —
    // a short beat is only to stop the two appearing in the same frame.
    if (msg.type === 'suggest' && typeof msg.text === 'string') {
      setTimeout(function () { addMsg('assistant', msg.text, true); }, 260);
      return;
    }
    if (msg.type === 'saveFailed') { flashFooter('Not saved', true); return; }
    if (msg.type === 'transcript' && typeof msg.text === 'string') { landTranscript(msg.text); return; }
    if (msg.type === 'voiceStage') { voiceState(msg.stage, msg.pct); return; }
    if (msg.type === 'voiceFailed') {
      voiceState('error', msg.reason ? 'Could not transcribe that.' : null);
      return;
    }
  });

  refreshSend();

  // Only now is this side able to hear anything, so only now is it honest to
  // say so. The extension answers with a full render; every field the first
  // frame could not paint (questions, and any state that changed while the
  // webview was loading) lands here.
  vscode.postMessage({ type: 'ready' });
})();
