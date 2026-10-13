'use strict';
/* tests/test-v8-businessline.test.js — v8 #26: per-key virtual business line.
 *
 * Pure unit tests: number determinism/format/collision-avoidance, missed-call
 * store round-trip + per-key isolation, inbound-call 30s no-answer tracking
 * with fake timers. No network, no API key.
 */
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var bl = require('../src/businessLine');
var agents = require('../src/agents');

var KH1 = 'a'.repeat(64);
var KH2 = 'b'.repeat(64);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-'));
}

function fakeTimers() {
  var pending = [];
  return {
    setTimer: function (cb, ms) { var t = { cb: cb, ms: ms, cleared: false }; pending.push(t); return t; },
    clearTimer: function (t) { t.cleared = true; },
    fire: function () { pending.forEach(function (t) { if (!t.cleared) t.cb(); }); }
  };
}

module.exports = {
  'number format is +1 (555) 014-XXXX': function () {
    var n = bl.numberForKeyHash(KH1);
    assert.match(n, /^\+1 \(555\) 014-\d{4}$/, 'got: ' + n);
  },

  'number is deterministic for the same keyHash': function () {
    assert.strictEqual(bl.numberForKeyHash(KH1), bl.numberForKeyHash(KH1));
  },

  'different keys (almost surely) get different numbers': function () {
    var nums = new Set();
    for (var i = 0; i < 50; i++) {
      var kh = require('crypto').createHash('sha256').update('key' + i).digest('hex');
      nums.add(bl.numberForKeyHash(kh));
    }
    assert.ok(nums.size > 45, 'expected spread, got ' + nums.size + ' distinct of 50');
  },

  'business-line numbers never collide with the 101 built-in agent numbers': function () {
    var builtinNums = new Set(agents.AGENTS.map(function (a) { return a.number; }));
    assert.ok(builtinNums.size >= 101, 'expected 101+ built-ins');
    for (var i = 0; i < 200; i++) {
      var kh = require('crypto').createHash('sha256').update('probe' + i).digest('hex');
      var n = bl.numberForKeyHash(kh);
      assert.ok(!bl.isBuiltInAgentNumber(n), 'looks like built-in: ' + n);
      assert.ok(!builtinNums.has(n), 'collision with built-in: ' + n);
      assert.ok(bl.isBusinessLineNumber(n));
    }
  },

  'garbage keyHash throws': function () {
    assert.throws(function () { bl.numberForKeyHash('nope'); });
    assert.throws(function () { bl.numberForKeyHash(null); });
  },

  'fictional provider implements the telephony contract': async function () {
    var p1 = await bl.FictionalTelephony.provisionNumber(KH1);
    var p2 = await bl.FictionalTelephony.provisionNumber(KH1);
    assert.strictEqual(p1.number, p2.number);
    assert.ok(bl.isBusinessLineNumber(p1.number));
    var r = await bl.FictionalTelephony.releaseNumber(KH1);
    assert.strictEqual(r.ok, true);
  },

  'missed-call store: log + list round-trip': async function () {
    var dir = tmpDir();
    var store = new bl.MissedCallStore(dir, KH1);
    var id = await store.log('+1 (555) 999-0000', 'no-answer');
    assert.ok(/^mc_/.test(id));
    var all = store.list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].from, '+1 (555) 999-0000');
    assert.strictEqual(all[0].reason, 'no-answer');
    assert.ok(all[0].at);
    fs.rmSync(dir, { recursive: true });
  },

  'missed-call store: per-key isolation': async function () {
    var dir = tmpDir();
    await new bl.MissedCallStore(dir, KH1).log('caller-a', 'no-answer');
    var other = new bl.MissedCallStore(dir, KH2).list();
    assert.strictEqual(other.length, 0, 'key 2 must not see key 1 misses');
    fs.rmSync(dir, { recursive: true });
  },

  'missed-call store: file name is per-key': function () {
    assert.strictEqual(bl.MissedCallStore.fileNameFor(KH1), 'missed_' + KH1 + '.json');
  },

  'inbound tracker: no answer within 30s logs a missed call': async function () {
    var dir = tmpDir();
    var ft = fakeTimers();
    var t = bl.trackInboundCall({ dataDir: dir, keyHash: KH1, from: 'caller-x', setTimer: ft.setTimer, clearTimer: ft.clearTimer });
    assert.strictEqual(t.loggedMissed(), false);
    ft.fire(); // 30s elapse
    await new Promise(function (r) { setTimeout(r, 20); }); // let the async log land
    assert.strictEqual(t.loggedMissed(), true);
    assert.strictEqual(t.isDone(), true);
    var all = new bl.MissedCallStore(dir, KH1).list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].from, 'caller-x');
    assert.strictEqual(all[0].reason, 'no-answer');
    fs.rmSync(dir, { recursive: true });
  },

  'inbound tracker: answered() before 30s logs nothing': async function () {
    var dir = tmpDir();
    var ft = fakeTimers();
    var t = bl.trackInboundCall({ dataDir: dir, keyHash: KH1, from: 'caller-y', setTimer: ft.setTimer, clearTimer: ft.clearTimer });
    t.answered();
    ft.fire();
    await new Promise(function (r) { setTimeout(r, 20); });
    assert.strictEqual(t.loggedMissed(), false);
    assert.strictEqual(new bl.MissedCallStore(dir, KH1).list().length, 0);
    fs.rmSync(dir, { recursive: true });
  },

  'inbound tracker: ended() before 30s logs nothing': async function () {
    var dir = tmpDir();
    var ft = fakeTimers();
    var t = bl.trackInboundCall({ dataDir: dir, keyHash: KH1, from: 'caller-z', setTimer: ft.setTimer, clearTimer: ft.clearTimer });
    t.ended();
    ft.fire();
    await new Promise(function (r) { setTimeout(r, 20); });
    assert.strictEqual(t.loggedMissed(), false);
    assert.strictEqual(new bl.MissedCallStore(dir, KH1).list().length, 0);
    fs.rmSync(dir, { recursive: true });
  }
};
