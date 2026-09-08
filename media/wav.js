// Audio conditioning for voice notes — the piece that lets Yield skip ffmpeg.
//
// whisper.cpp wants 16 kHz mono 16-bit PCM. MediaRecorder gives webm/opus at
// the device rate (usually 48 kHz, stereo). The usual fix is to shell out to
// ffmpeg; instead the webview decodes the recording with the Web Audio API and
// does the conditioning here, in about a hundred lines. nodejs-whisper only
// reaches for ffmpeg when the input needs resampling, so handing it a file that
// is ALREADY 16 kHz means that path is never taken — no ffmpeg at build time or
// runtime.
//
// Pure functions, no DOM, exported to both `window` (the webview) and
// `module.exports` (the Node tests), so the thing under test is the thing that
// ships.

(function (root) {
  'use strict';

  var TARGET_RATE = 16000;

  // whisper drops the first word when a clip starts abruptly on speech — proven
  // both ways in the stage 1 spike. Half a second of leading silence fixes it.
  // Done in the BUFFER, not by starting the recorder early: we cannot record
  // before the user clicks, and padding here is deterministic and free.
  var LEAD_SILENCE_SEC = 0.5;

  /** Average all channels down to one. Whisper is mono; a stereo mic would
   *  otherwise halve the effective sample rate after naive channel picking. */
  function toMono(channelData, length) {
    if (channelData.length === 1) { return channelData[0]; }
    var out = new Float32Array(length);
    for (var c = 0; c < channelData.length; c++) {
      var ch = channelData[c];
      for (var i = 0; i < length; i++) { out[i] += ch[i] / channelData.length; }
    }
    return out;
  }

  /**
   * Resample to `outRate`. Downsampling AVERAGES each source window rather than
   * picking one sample: plain decimation aliases high frequencies down into the
   * speech band and measurably hurts recognition. Upsampling (a <16 kHz mic)
   * interpolates instead, since there is no window to average.
   */
  function resample(samples, inRate, outRate) {
    if (inRate === outRate) { return samples; }
    var ratio = inRate / outRate;
    var outLength = Math.floor(samples.length / ratio);
    var out = new Float32Array(outLength);

    if (ratio > 1) {
      for (var i = 0; i < outLength; i++) {
        var start = Math.floor(i * ratio);
        var end = Math.min(Math.floor((i + 1) * ratio), samples.length);
        var sum = 0;
        for (var j = start; j < end; j++) { sum += samples[j]; }
        out[i] = end > start ? sum / (end - start) : 0;
      }
    } else {
      for (var k = 0; k < outLength; k++) {
        var pos = k * ratio;
        var lo = Math.floor(pos);
        var hi = Math.min(lo + 1, samples.length - 1);
        var frac = pos - lo;
        out[k] = samples[lo] * (1 - frac) + samples[hi] * frac;
      }
    }
    return out;
  }

  /** Float [-1,1] to signed 16-bit, clamped so overdriven input wraps to the
   *  rail instead of round-tripping into noise. */
  function toPcm16(samples, view, offset) {
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (s > 1) { s = 1; } else if (s < -1) { s = -1; }
      view.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  /**
   * Wrap 16 kHz mono float samples in a RIFF/WAVE container, with the leading
   * silence prepended. Returns a Uint8Array ready to hand to the extension.
   */
  function encodeWav(samples, sampleRate, leadSilenceSec) {
    var rate = sampleRate || TARGET_RATE;
    var lead = Math.round(rate * (leadSilenceSec === undefined ? LEAD_SILENCE_SEC : leadSilenceSec));
    var frames = lead + samples.length;
    var dataBytes = frames * 2;
    var buffer = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buffer);

    function ascii(offset, str) {
      for (var i = 0; i < str.length; i++) { view.setUint8(offset + i, str.charCodeAt(i)); }
    }

    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);          // PCM chunk size
    view.setUint16(20, 1, true);           // format = PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, rate, true);        // THE field nodejs-whisper checks
    view.setUint32(28, rate * 2, true);    // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);

    // The lead is already zeroed by ArrayBuffer; write speech after it.
    toPcm16(samples, view, 44 + lead * 2);
    return new Uint8Array(buffer);
  }

  /**
   * The whole conditioning step: an AudioBuffer (or anything with the same
   * shape, which is what the Node tests pass) in, a whisper-ready WAV out.
   */
  function fromAudioBuffer(audioBuffer, leadSilenceSec) {
    var channels = [];
    for (var c = 0; c < audioBuffer.numberOfChannels; c++) {
      channels.push(audioBuffer.getChannelData(c));
    }
    var mono = toMono(channels, audioBuffer.length);
    var down = resample(mono, audioBuffer.sampleRate, TARGET_RATE);
    return encodeWav(down, TARGET_RATE, leadSilenceSec);
  }

  /** Webview postMessage is a JSON hop; raw bytes would balloon into an array
   *  of numbers, so the WAV crosses as base64. */
  function toBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;   // avoid blowing the argument limit on long clips
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    if (typeof btoa === 'function') { return btoa(binary); }
    return Buffer.from(binary, 'binary').toString('base64');   // Node, for tests
  }

  var api = {
    TARGET_RATE: TARGET_RATE,
    LEAD_SILENCE_SEC: LEAD_SILENCE_SEC,
    toMono: toMono,
    resample: resample,
    encodeWav: encodeWav,
    fromAudioBuffer: fromAudioBuffer,
    toBase64: toBase64
  };

  root.YieldWav = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
