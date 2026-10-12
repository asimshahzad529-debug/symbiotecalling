'use strict';
/* tests/test-v7-5-greeting-mask.test.js — v7.5 (fixing release):
 * greeting-mask state machine (window.GreetingMask, public/greeting.js).
 *
 * The mask is pure logic: idle -> masking -> revealed | revealed_fallback,
 * exactly-once reveal, 7s default hard cap. Timers are injected fakes;
 * no DOM, no network, no API key. Mic gating is app.js territory — these
 * tests assert the mask stays decoupled from it (no mic/DOM surface).
 */
var assert = require('assert');

global.window = global.window || {};
require('../public/greeting');
var GreetingMask = global.window.GreetingMask;

function fakeTimers() {
  var pending = [];
  return {
    setTimer: function (cb, ms) { var t = { cb: cb, ms: ms, cleared: false }; pending.push(t); return t; },
    clearTimer: function (t) { t.cleared = true; },
    pending: pending,
    fire: function () { pending.forEach(function (t) { if (!t.cleared) t.cb(); }); }
  };
}

function make(events, timeoutMs) {
  var ft = fakeTimers();
  var opts = {
    setTimer: ft.setTimer,
    clearTimer: ft.clearTimer,
    onMask: function () { events.push('mask'); },
    onReveal: function (how) { events.push('reveal:' + how); }
  };
  if (typeof timeoutMs === 'number') opts.timeoutMs = timeoutMs;
  return { mask: GreetingMask.create(opts), ft: ft };
}

module.exports = {
  'mask exists with default 7s cap': function () {
    var events = [];
    var m = make(events);
    assert.strictEqual(GreetingMask.DEFAULT_TIMEOUT_MS, 7000);
    m.mask.start();
    assert.strictEqual(m.ft.pending.length, 1);
    assert.strictEqual(m.ft.pending[0].ms, 7000);
  },

  'mask: audio arrival reveals exactly once, cancels timer': function () {
    var events = [];
    var m = make(events);
    assert.strictEqual(m.mask.getState(), 'idle');
    assert.strictEqual(m.mask.start(), true);
    assert.strictEqual(m.mask.getState(), 'masking');
    assert.strictEqual(m.mask.isMasking(), true);
    assert.deepStrictEqual(events, ['mask']);
    assert.strictEqual(m.mask.onAudio('audio'), true);
    assert.strictEqual(m.mask.getState(), 'revealed');
    assert.strictEqual(m.mask.isMasking(), false);
    assert.deepStrictEqual(events, ['mask', 'reveal:audio']);
    assert.strictEqual(m.ft.pending[0].cleared, true); // timer cancelled
    m.ft.fire(); // firing the cancelled timer must not reveal again
    assert.deepStrictEqual(events, ['mask', 'reveal:audio']);
  },

  'mask: timeout reveals with fallback': function () {
    var events = [];
    var m = make(events);
    m.mask.start();
    m.ft.fire();
    assert.strictEqual(m.mask.getState(), 'revealed_fallback');
    assert.deepStrictEqual(events, ['mask', 'reveal:fallback']);
  },

  'mask: late audio after timeout does not double-reveal': function () {
    var events = [];
    var m = make(events);
    m.mask.start();
    m.ft.fire();
    assert.strictEqual(m.mask.onAudio('audio'), false);
    assert.strictEqual(m.mask.onTimeout(), false);
    assert.deepStrictEqual(events, ['mask', 'reveal:fallback']);
  },

  'mask: double audio does not double-reveal': function () {
    var events = [];
    var m = make(events);
    m.mask.start();
    assert.strictEqual(m.mask.onAudio('audio'), true);
    assert.strictEqual(m.mask.onAudio('audio'), false);
    assert.deepStrictEqual(events, ['mask', 'reveal:audio']);
  },

  'mask: text greeting also reveals (first output frame)': function () {
    var events = [];
    var m = make(events);
    m.mask.start();
    assert.strictEqual(m.mask.onAudio('text'), true);
    assert.strictEqual(m.mask.getState(), 'revealed');
    assert.deepStrictEqual(events, ['mask', 'reveal:text']);
  },

  'mask: audio before start is a no-op': function () {
    var events = [];
    var m = make(events);
    assert.strictEqual(m.mask.onAudio('audio'), false);
    assert.deepStrictEqual(events, []);
  },

  'mask: start twice does not re-arm': function () {
    var events = [];
    var m = make(events);
    assert.strictEqual(m.mask.start(), true);
    assert.strictEqual(m.mask.start(), false);
    assert.strictEqual(m.ft.pending.length, 1);
  },

  'mask: reset clears timer and allows reuse for next call': function () {
    var events = [];
    var m = make(events);
    m.mask.start();
    m.mask.reset();
    assert.strictEqual(m.mask.getState(), 'idle');
    m.ft.fire(); // stale timer fires after reset: nothing happens
    assert.deepStrictEqual(events, ['mask']);
    assert.strictEqual(m.mask.start(), true);
    assert.strictEqual(m.mask.onAudio('audio'), true);
    assert.deepStrictEqual(events, ['mask', 'mask', 'reveal:audio']);
  },

  'mask: decoupled from mic gating (no mic/DOM surface)': function () {
    var events = [];
    var m = make(events);
    var keys = Object.keys(m.mask).sort();
    assert.deepStrictEqual(keys, ['getState', 'isMasking', 'onAudio', 'onTimeout', 'reset', 'start']);
    m.mask.start();
    m.mask.onAudio('audio');
    // Nothing in the mask touches the mic or the DOM: app.js wires
    // ungateMic separately and keeps it untouched by this change.
    assert.deepStrictEqual(events, ['mask', 'reveal:audio']);
  }
};
