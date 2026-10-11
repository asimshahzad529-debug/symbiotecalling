'use strict';
/* tests/resample.test.js — the exact DSP code from public/worklet.js.
 * Known nonzero tone: 440 Hz sine must survive resampling with correct
 * length, nonzero RMS, and preserved frequency (via zero crossings).
 */
var assert = require('assert');
var w = require('../public/worklet.js');

function sine440(rate, seconds, amp) {
  var n = Math.floor(rate * seconds), out = new Float32Array(n);
  for (var i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * 440 * i / rate);
  return out;
}
function rms(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); }
function zeroCrossings(a) { var c = 0; for (var i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) c++; return c; }

function checkTone(fromRate) {
  var src = sine440(fromRate, 1.0, 0.5);
  var out = w.resampleLinear(src, fromRate, 16000);
  var expectedLen = Math.floor(src.length / (fromRate / 16000));
  assert.strictEqual(out.length, expectedLen, 'length ' + fromRate + '->16000');
  var r = rms(out);
  assert.ok(r > 0.2 && r < 0.5, 'nonzero RMS, got ' + r);
  var zc = zeroCrossings(out);
  // 440 Hz * 2 crossings per cycle = 880 expected; allow 3% tolerance.
  assert.ok(Math.abs(zc - 880) / 880 < 0.03, 'frequency preserved, crossings=' + zc);
}

module.exports = {
  'tone 44100 -> 16000 keeps length, energy, frequency': function () { checkTone(44100); },
  'tone 48000 -> 16000 keeps length, energy, frequency': function () { checkTone(48000); },
  'silence stays silence': function () {
    var out = w.resampleLinear(new Float32Array(44100), 44100, 16000);
    assert.strictEqual(out.length, 16000);
    for (var i = 0; i < out.length; i++) assert.strictEqual(out[i], 0);
  },
  'same rate is identity': function () {
    var src = sine440(16000, 0.1, 0.5);
    var out = w.resampleLinear(src, 16000, 16000);
    assert.strictEqual(out.length, src.length);
    for (var i = 0; i < src.length; i++) assert.strictEqual(out[i], src[i]);
  },
  'empty input gives empty output': function () {
    assert.strictEqual(w.resampleLinear(new Float32Array(0), 48000, 16000).length, 0);
  },
  'floatTo16BitPCM clamps and scales': function () {
    var p = w.floatTo16BitPCM(new Float32Array([1, -1, 0, 2, -2, 0.5]));
    assert.strictEqual(p[0], 32767);
    assert.strictEqual(p[1], -32768);
    assert.strictEqual(p[2], 0);
    assert.strictEqual(p[3], 32767);
    assert.strictEqual(p[4], -32768);
    assert.strictEqual(p[5], 16384);
  }
};
