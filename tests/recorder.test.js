'use strict';
/* tests/recorder.test.js — node tests for public/recorder.js (UMD module).
 *
 * WHAT IS BROWSER-ONLY AND NOT COVERED HERE:
 *  - Real audio capture: no actual microphone or MediaStreamAudioDestinationNode
 *    combined stream is recorded in these tests — a FakeMediaStream stands in.
 *  - Real MediaRecorder encoding: MediaRecorder is fully faked below; no real
 *    browser MediaRecorder runs in node.
 *  - Actual webm validity: the test Blob is built from fake byte chunks, so the
 *    test proves plumbing (chunks -> Blob), NOT that the bytes decode as webm.
 *  - Microphone permission prompts: browser-only; not exercised here.
 *  - Real elapsed-time accuracy beyond Date.now() arithmetic.
 *
 * Fakes below mimic the MediaRecorder surface the module uses
 * (constructor(stream, opts), isTypeSupported, start, stop,
 *  ondataavailable, onstop, onerror, state).
 */
var assert = require('assert');
var CallRecorder = require('../public/recorder.js');

/* ---------- minimal fakes (defined at top, restored afterwards) ---------- */
var CHUNK_A = Buffer.from('fake-audio-chunk-a');
var CHUNK_B = Buffer.from('fake-audio-chunk-b');

function FakeMediaStream() { /* stand-in: only truthiness matters to the module */ }

function FakeMediaRecorder(stream, opts) {
  this.stream = stream;
  this.mimeType = (opts && opts.mimeType) || '';
  this.state = 'inactive';
  this.ondataavailable = null;
  this.onstop = null;
  this.onerror = null;
}
FakeMediaRecorder.isTypeSupported = function (t) {
  return t === 'audio/webm;codecs=opus'; /* only the first candidate is "supported" */
};
FakeMediaRecorder.prototype.start = function () {
  this.state = 'recording';
  var self = this;
  [CHUNK_A, CHUNK_B].forEach(function (c) {
    if (self.ondataavailable) self.ondataavailable({ data: c });
  });
};
FakeMediaRecorder.prototype.stop = function () {
  this.state = 'inactive';
  if (this.onstop) this.onstop();
};

var prevWindow = global.window;
global.window = { MediaRecorder: FakeMediaRecorder };

function fresh() { return new CallRecorder(); }

module.exports = {
  'initial state is idle': function () {
    assert.strictEqual(fresh().getState(), 'idle');
  },
  'isSupported true with stubbed MediaRecorder': function () {
    assert.strictEqual(CallRecorder.isSupported(), true);
  },
  'isSupported false without window': function () {
    delete global.window;
    assert.strictEqual(CallRecorder.isSupported(), false);
    global.window = { MediaRecorder: FakeMediaRecorder }; /* restore stub */
  },
  'start returns true and state becomes recording': function () {
    var r = fresh();
    assert.strictEqual(r.start(new FakeMediaStream()), true);
    assert.strictEqual(r.getState(), 'recording');
  },
  'second start returns false': function () {
    var r = fresh();
    assert.strictEqual(r.start(new FakeMediaStream()), true);
    assert.strictEqual(r.start(new FakeMediaStream()), false);
    assert.strictEqual(r.getState(), 'recording');
  },
  'getElapsedMs is >= 0 while recording': function () {
    var r = fresh();
    r.start(new FakeMediaStream());
    var ms = r.getElapsedMs();
    assert.strictEqual(typeof ms, 'number');
    assert.ok(ms >= 0, 'expected >= 0, got ' + ms);
  },
  'getElapsedMs is 0 while idle': function () {
    assert.strictEqual(fresh().getElapsedMs(), 0);
  },
  'start with null stream returns false': function () {
    var r = fresh();
    assert.strictEqual(r.start(null), false);
    assert.strictEqual(r.getState(), 'idle');
  },
  'start unsupported (no window) returns false': function () {
    delete global.window;
    var r = fresh();
    assert.strictEqual(r.start(new FakeMediaStream()), false);
    assert.strictEqual(r.getState(), 'idle');
    global.window = { MediaRecorder: FakeMediaRecorder }; /* restore stub */
  },
  'stop resolves a Blob with the fake chunks and state becomes stopped': async function () {
    var r = fresh();
    r.start(new FakeMediaStream());
    var blob = await r.stop();
    assert.ok(blob instanceof Blob, 'expected a Blob');
    assert.ok(blob.size >= CHUNK_A.length + CHUNK_B.length,
      'blob should contain the fake chunks, size=' + blob.size);
    assert.strictEqual(blob.type, 'audio/webm;codecs=opus');
    assert.strictEqual(r.getState(), 'stopped');
  },
  'stop when idle resolves null': async function () {
    var r = fresh();
    assert.strictEqual(await r.stop(), null);
    assert.strictEqual(r.getState(), 'idle');
  },
  'stop never rejects after a throw inside recorder stop': async function () {
    var r = fresh();
    r.start(new FakeMediaStream());
    r._recorder.stop = function () { throw new Error('boom'); };
    assert.strictEqual(await r.stop(), null);
    assert.strictEqual(r.getState(), 'error');
  },
  'restore global window': function () {
    if (prevWindow === undefined) delete global.window;
    else global.window = prevWindow;
  }
};
