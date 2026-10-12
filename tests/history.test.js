'use strict';
/* tests/history.test.js — call-history log: metadata only, atomic. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var storeMod = require('../src/store');

function tmpHistory() { return new storeMod.CallHistory(fs.mkdtempSync(path.join(os.tmpdir(), 'call-hist-'))); }

module.exports = {
  'logStart then logEnd records duration': async function () {
    var h = tmpHistory();
    var id = await h.logStart({ agentId: 'ava', agentName: 'Ava', number: '+1 (555) 010-0001' });
    assert.ok(id);
    await new Promise(function (r) { setTimeout(r, 1100); });
    await h.logEnd(id);
    var all = h.list();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].agentId, 'ava');
    assert.ok(all[0].endedAt);
    assert.ok(all[0].durationSec >= 1, 'duration measured, got ' + all[0].durationSec);
  },
  'logEnd is idempotent': async function () {
    var h = tmpHistory();
    var id = await h.logStart({ agentId: 'ava', agentName: 'Ava', number: 'x' });
    await h.logEnd(id);
    var d1 = h.list()[0].durationSec;
    await h.logEnd(id);
    assert.strictEqual(h.list()[0].durationSec, d1);
    assert.strictEqual(h.list().length, 1);
  },
  'clear empties history': async function () {
    var h = tmpHistory();
    var id = await h.logStart({ agentId: 'ava', agentName: 'Ava', number: 'x' });
    await h.logEnd(id);
    await h.clear();
    assert.deepStrictEqual(h.list(), []);
  },
  'history persists across instances': async function () {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'call-hist-'));
    var h1 = new storeMod.CallHistory(d);
    var id = await h1.logStart({ agentId: 'marco', agentName: 'Marco', number: 'y' });
    await h1.logEnd(id);
    var h2 = new storeMod.CallHistory(d);
    assert.strictEqual(h2.list().length, 1);
    assert.strictEqual(h2.list()[0].agentName, 'Marco');
  },
  'per-key partitions isolate history: same key persists, other key empty, switch back intact': async function () {
    var d = fs.mkdtempSync(path.join(os.tmpdir(), 'call-hist-'));
    var khA = 'a'.repeat(64), khB = 'b'.repeat(64);
    var hA = new storeMod.CallHistory(d, khA);
    var id = await hA.logStart({ agentId: 'ava', agentName: 'Ava', number: 'x' });
    await hA.logEnd(id);
    // same key, new instance: data persists
    assert.strictEqual(new storeMod.CallHistory(d, khA).list().length, 1, 'same key persists');
    // different key: separate empty data, nothing wiped
    var hB = new storeMod.CallHistory(d, khB);
    assert.strictEqual(hB.list().length, 0, 'different key sees empty data');
    await hB.logStart({ agentId: 'marco', agentName: 'Marco', number: 'y' });
    // switching back: original data intact
    assert.strictEqual(new storeMod.CallHistory(d, khA).list().length, 1, 'original data intact');
    assert.strictEqual(new storeMod.CallHistory(d, khB).list().length, 1);
    assert.ok(fs.existsSync(path.join(d, 'calls_' + khA + '.json')), 'partitioned file used');
    assert.ok(!fs.existsSync(path.join(d, 'calls.json')), 'legacy file untouched');
    // keyHash is validated and normalized
    assert.strictEqual(storeMod.CallHistory.fileNameFor(khA), 'calls_' + khA + '.json');
    assert.throws(function () { new storeMod.CallHistory(d, 'garbage'); }, /64 hex/);
    assert.throws(function () { new storeMod.CallHistory(d, 'a'.repeat(63)); }, /64 hex/);
    var upper = new storeMod.CallHistory(d, 'A'.repeat(64));
    assert.strictEqual(upper.file, path.join(d, 'calls_' + khA + '.json'), 'uppercase hash normalized');
  }
};
