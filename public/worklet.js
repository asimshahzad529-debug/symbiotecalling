'use strict';
/**
 * public/worklet.js — AudioWorklet capture processor for OMNI.
 *
 * Captures mono microphone input, resamples to 16 kHz with linear
 * interpolation (correct for non-integer ratios such as 44100 -> 16000),
 * converts to PCM16, and posts chunks to the main thread.
 *
 * The DSP helpers (resampleLinear, floatTo16BitPCM) are pure functions and are
 * also exported for Node so the unit tests exercise the exact same code that
 * runs in the browser. Mirrors of this algorithm must not drift: there is only
 * one implementation, in this file.
 */

var TARGET_RATE = 16000;

/**
 * Linear-interpolation resampler. Handles any from/to rate pair, including
 * non-integer ratios (e.g. 44100 -> 16000, ratio 2.75625).
 * @param {Float32Array|number[]} input mono samples
 * @param {number} fromRate source sample rate (Hz)
 * @param {number} toRate destination sample rate (Hz)
 * @returns {Float32Array} resampled mono samples
 */
function resampleLinear(input, fromRate, toRate) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return Float32Array.from(input);
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error('resampleLinear: invalid rates');
  var ratio = fromRate / toRate;
  var outLen = Math.max(0, Math.floor(input.length / ratio));
  var out = new Float32Array(outLen);
  var last = input.length - 1;
  for (var i = 0; i < outLen; i++) {
    var pos = i * ratio;
    var i0 = Math.floor(pos);
    if (i0 > last) i0 = last;
    var i1 = i0 + 1 <= last ? i0 + 1 : last;
    var frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/**
 * Convert float [-1,1] samples to signed 16-bit PCM (little-endian bytes
 * are the caller's concern; this returns an Int16Array).
 */
function floatTo16BitPCM(float32) {
  var out = new Int16Array(float32.length);
  for (var i = 0; i < float32.length; i++) {
    var s = float32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

/** RMS of a float buffer; used for the input-level meter (never sent). */
function rms(float32) {
  if (!float32 || float32.length === 0) return 0;
  var sum = 0;
  for (var i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

// ---- AudioWorklet side (only defined inside a worklet global) ----
if (typeof registerProcessor !== 'undefined') {
  class OmniCapture extends AudioWorkletProcessor {
    constructor() {
      super();
      this._fromRate = sampleRate; // worklet global: input device rate
      this._muted = false;
      this.port.onmessage = (e) => {
        if (e && e.data && typeof e.data.muted === 'boolean') this._muted = e.data.muted;
      };
    }
    process(inputs) {
      var ch = inputs && inputs[0] && inputs[0][0];
      if (ch && ch.length > 0) {
        var resampled = resampleLinear(ch, this._fromRate, TARGET_RATE);
        var pcm16 = floatTo16BitPCM(resampled);
        // Always report a level so the UI meter works even when muted.
        this.port.postMessage({ level: rms(resampled) }, []);
        if (!this._muted && pcm16.length > 0) {
          // Transfer the buffer; main thread base64-encodes it.
          this.port.postMessage({ pcm: pcm16.buffer }, [pcm16.buffer]);
        }
      }
      return true; // keep alive
    }
  }
  registerProcessor('omni-capture', OmniCapture);
}

// ---- Node side (unit tests) ----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resampleLinear: resampleLinear, floatTo16BitPCM: floatTo16BitPCM, rms: rms, TARGET_RATE: TARGET_RATE };
}
