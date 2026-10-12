'use strict';
/* tests/persistence.test.js — FEATURE 3 (v6): backup/restore (importAll),
 * auto summaries (setSummary), and DATA_DIR-style custom-dir isolation. */
var fs = require('fs');
var os = require('os');
var path = require('path');
var assert = require('assert');
var CallHistory = require('../src/store.js').CallHistory;
var MemoryStore = require('../src/memory.js').MemoryStore;

var KEY = 'test-key-hash';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persist-test-'));
}

function callInfo(n) {
  return { agentId: 'a' + n, agentName: 'Agent' + n, number: '+1555010000' + n };
}

function memInfo(n) {
  return { keyHash: KEY, agentId: 'a' + n, agentName: 'Agent' + n, number: '+1555010000' + n };
}

exports['history writes into custom dataDir'] = async function () {
  var dir = tmpdir();
  var h = new CallHistory(dir);
  var id = await h.logStart(callInfo(1));
  assert.strictEqual(typeof id, 'string');
  assert.ok(fs.existsSync(path.join(dir, 'calls.json')), 'calls.json lands in the given dir');
  assert.strictEqual(h.list().length, 1);
};

exports['memory writes into custom dataDir'] = async function () {
  var dir = tmpdir();
  var m = new MemoryStore(dir);
  var id = await m.beginCall(memInfo(1));
  assert.strictEqual(typeof id, 'string');
  assert.ok(fs.existsSync(path.join(dir, 'memories.json')), 'memories.json lands in the given dir');
  assert.strictEqual(m.list(KEY).length, 1);
};

exports['history importAll replaces and round-trips'] = async function () {
  var dir = tmpdir();
  var h = new CallHistory(dir);
  await h.logStart(callInfo(1));
  await h.logStart(callInfo(2));
  assert.strictEqual(h.list().length, 2);
  var n = await h.importAll([
    { id: 'c1', agentName: 'Restored1' },
    'not-an-object',
    42,
    null,
    { id: 'c2', agentName: 'Restored2' },
    { id: 'c3', agentName: 'Restored3' }
  ]);
  assert.strictEqual(n, 3, 'non-object entries skipped, count is object entries only');
  var ids = h.list().map(function (e) { return e.id; });
  assert.deepStrictEqual(ids, ['c1', 'c2', 'c3']);
};

exports['memory importAll replaces and round-trips'] = async function () {
  var dir = tmpdir();
  var m = new MemoryStore(dir);
  await m.beginCall(memInfo(1));
  await m.beginCall(memInfo(2));
  assert.strictEqual(m.list(KEY).length, 2);
  function memEntry(id) {
    return { id: id, keyHash: KEY, agentId: 'a', agentName: 'A', number: '1',
             startedAt: '2026-01-01T00:00:00Z', endedAt: null, durationSec: null,
             notes: [], transcript: [] };
  }
  var n = await m.importAll([memEntry('m1'), 'junk', memEntry('m2'), memEntry('m3'), undefined]);
  assert.strictEqual(n, 3);
  var ids = m.list(KEY).map(function (e) { return e.id; });
  assert.deepStrictEqual(ids, ['m1', 'm2', 'm3']);
};

exports['importAll throws on non-array input'] = async function () {
  var dir = tmpdir();
  var h = new CallHistory(dir);
  var m = new MemoryStore(dir);
  await assert.rejects(function () { return h.importAll({}); }, /expects an array/);
  await assert.rejects(function () { return m.importAll('nope'); }, /expects an array/);
  await assert.rejects(function () { return h.importAll(null); }, /expects an array/);
  await assert.rejects(function () { return m.importAll(undefined); }, /expects an array/);
};

exports['history setSummary persists on right entry, leaves others untouched'] = async function () {
  var dir = tmpdir();
  var h = new CallHistory(dir);
  var id1 = await h.logStart(callInfo(1));
  var id2 = await h.logStart(callInfo(2));
  await h.setSummary(id2, 'caller interested, follow up');
  var all = h.list();
  var e2 = all.find(function (e) { return e.id === id2; });
  var e1 = all.find(function (e) { return e.id === id1; });
  assert.strictEqual(e2.summary, 'caller interested, follow up');
  assert.strictEqual(e1.summary, undefined);
  // truncation at 2000 chars
  await h.setSummary(id1, 'x'.repeat(5000));
  assert.strictEqual(h.list().find(function (e) { return e.id === id1; }).summary.length, 2000);
};

exports['history setSummary on unknown id is a no-op'] = async function () {
  var dir = tmpdir();
  var h = new CallHistory(dir);
  await h.logStart(callInfo(1));
  await h.setSummary('does-not-exist', 'blah'); // must not throw
  var all = h.list();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].summary, undefined);
};

exports['memory setSummary persists on right entry, leaves others untouched'] = async function () {
  var dir = tmpdir();
  var m = new MemoryStore(dir);
  var id1 = await m.beginCall(memInfo(1));
  var id2 = await m.beginCall(memInfo(2));
  await m.setSummary(id2, 'lead captured: acme corp');
  var g2 = m.get(id2);
  var g1 = m.get(id1);
  assert.strictEqual(g2.summary, 'lead captured: acme corp');
  assert.strictEqual(g1.summary, undefined);
  // truncation at 2000 chars
  await m.setSummary(id1, 'y'.repeat(9999));
  assert.strictEqual(m.get(id1).summary.length, 2000);
};

exports['memory setSummary on unknown id is a no-op'] = async function () {
  var dir = tmpdir();
  var m = new MemoryStore(dir);
  await m.beginCall(memInfo(1));
  await m.setSummary('nope', 'blah'); // must not throw
  assert.strictEqual(m.list(KEY).length, 1);
  assert.strictEqual(m.list(KEY)[0].summary, undefined);
};

exports['fresh stores in another temp dir start empty'] = async function () {
  var d1 = tmpdir();
  var d2 = tmpdir();
  var h1 = new CallHistory(d1);
  await h1.logStart(callInfo(1));
  assert.strictEqual(h1.list().length, 1);
  var h2 = new CallHistory(d2);
  assert.strictEqual(h2.list().length, 0);
  var m2 = new MemoryStore(d2);
  assert.strictEqual(m2.list(KEY).length, 0);
};

exports['history importAll result survives a fresh instance'] = async function () {
  var dir = tmpdir();
  var h = new CallHistory(dir);
  var n = await h.importAll([{ id: 'r1' }, { id: 'r2' }]);
  assert.strictEqual(n, 2);
  var h2 = new CallHistory(dir);
  assert.deepStrictEqual(h2.list().map(function (e) { return e.id; }), ['r1', 'r2']);
};

exports['per-key history partition writes to calls_<hash>.json'] = async function () {
  var dir = tmpdir();
  var kh = 'd'.repeat(64);
  var h = new CallHistory(dir, kh);
  var id = await h.logStart(callInfo(1));
  assert.strictEqual(typeof id, 'string');
  assert.ok(fs.existsSync(path.join(dir, 'calls_' + kh + '.json')), 'calls_<hash>.json lands in the given dir');
  assert.ok(!fs.existsSync(path.join(dir, 'calls.json')), 'legacy file untouched');
  assert.strictEqual(h.list().length, 1);
  // importAll/clear are scoped to the partition
  await h.clear();
  assert.strictEqual(h.list().length, 0);
  assert.strictEqual(new CallHistory(dir, 'e'.repeat(64)).list().length, 0);
};

exports['per-key memory partition writes to memories_<hash>.json'] = async function () {
  var dir = tmpdir();
  var kh = 'd'.repeat(64);
  var m = new MemoryStore(dir, kh);
  var id = await m.beginCall({ keyHash: kh, agentId: 'a1', agentName: 'Agent1', number: '+15550100001' });
  assert.strictEqual(typeof id, 'string');
  assert.ok(fs.existsSync(path.join(dir, 'memories_' + kh + '.json')), 'memories_<hash>.json lands in the given dir');
  assert.ok(!fs.existsSync(path.join(dir, 'memories.json')), 'legacy file untouched');
  assert.strictEqual(m.list(kh).length, 1);
  // recall still filters by the entry's own keyHash field
  var rec = m.recall('a1', kh, 3);
  assert.strictEqual(rec.length, 0, 'call not ended yet -> not recalled');
  await m.endCall(id);
  assert.strictEqual(m.recall('a1', kh, 3).length, 1);
};
