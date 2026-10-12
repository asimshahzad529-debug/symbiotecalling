'use strict';
/* tests/cleanup.test.js — v7 WS7 hygiene: auto-cleanup (server side).
 * src/cleanup.js pure helpers + CallHistory/MemoryStore prune methods. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var cleanup = require('../src/cleanup');
var storeMod = require('../src/store');
var memoryMod = require('../src/memory');

var DAY = 24 * 60 * 60 * 1000;
var NOW = Date.parse('2026-10-12T12:00:00.000Z');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ws7-cleanup-')); }
function isoAgo(days) { return new Date(NOW - days * DAY).toISOString(); }

module.exports = {
  'isOlderThan: 31 days ago vs 30-day retention -> true': function () {
    assert.strictEqual(cleanup.isOlderThan(isoAgo(31), 30, NOW), true);
  },
  'isOlderThan: exactly at the boundary is kept': function () {
    assert.strictEqual(cleanup.isOlderThan(isoAgo(30), 30, NOW), false);
  },
  'isOlderThan: 5 days ago is kept': function () {
    assert.strictEqual(cleanup.isOlderThan(isoAgo(5), 30, NOW), false);
  },
  'isOlderThan: missing/invalid timestamps are kept': function () {
    assert.strictEqual(cleanup.isOlderThan(null, 30, NOW), false);
    assert.strictEqual(cleanup.isOlderThan('', 30, NOW), false);
    assert.strictEqual(cleanup.isOlderThan('not-a-date', 30, NOW), false);
  },
  'isOlderThan: future timestamps are kept': function () {
    assert.strictEqual(cleanup.isOlderThan(new Date(NOW + DAY).toISOString(), 30, NOW), false);
  },
  'retentionDays: default 30, clamps bad input': function () {
    assert.strictEqual(cleanup.retentionDays(undefined), 30);
    assert.strictEqual(cleanup.retentionDays('abc'), 30);
    assert.strictEqual(cleanup.retentionDays(0), 30);
    assert.strictEqual(cleanup.retentionDays(-5), 30);
    assert.strictEqual(cleanup.retentionDays(7), 7);
    assert.strictEqual(cleanup.retentionDays(99999), 3650);
  },
  'filterFresh: drops only old records': function () {
    var recs = [
      { id: 'a', startedAt: isoAgo(40) },
      { id: 'b', startedAt: isoAgo(10) },
      { id: 'c' },
      { id: 'd', startedAt: 'garbage' }
    ];
    var fresh = cleanup.filterFresh(recs, 30, NOW);
    assert.deepStrictEqual(fresh.map(function (r) { return r.id; }).sort(), ['b', 'c', 'd']);
  },
  'CallHistory.pruneOlderThan removes old records and returns the count': async function () {
    var dir = tmpdir();
    var h = new storeMod.CallHistory(dir);
    await h.importAll([
      { id: 'old1', startedAt: new Date(Date.now() - 40 * DAY).toISOString() },
      { id: 'new1', startedAt: new Date().toISOString() },
      { id: 'nodate' }
    ]);
    var removed = await h.pruneOlderThan(30);
    assert.strictEqual(removed, 1, 'one record removed');
    var ids = h.list().map(function (r) { return r.id; }).sort();
    assert.deepStrictEqual(ids, ['new1', 'nodate']);
  },
  'CallHistory.pruneOlderThan on a keyed partition': async function () {
    var dir = tmpdir();
    var kh = 'c'.repeat(64);
    var h = new storeMod.CallHistory(dir, kh);
    await h.importAll([{ id: 'old', startedAt: new Date(Date.now() - 60 * DAY).toISOString() }]);
    assert.strictEqual(await h.pruneOlderThan(30), 1);
    assert.strictEqual(h.list().length, 0);
    assert.ok(fs.existsSync(path.join(dir, 'calls_' + kh + '.json')), 'partition file intact');
  },
  'CallHistory.pruneAll prunes legacy + keyed partitions, skips corrupt files': async function () {
    var dir = tmpdir();
    var kh = 'd'.repeat(64);
    var legacy = new storeMod.CallHistory(dir);
    await legacy.importAll([{ id: 'l-old', startedAt: new Date(Date.now() - 45 * DAY).toISOString() }]);
    var keyed = new storeMod.CallHistory(dir, kh);
    await keyed.importAll([{ id: 'k-old', startedAt: new Date(Date.now() - 45 * DAY).toISOString() },
                           { id: 'k-new', startedAt: new Date().toISOString() }]);
    fs.writeFileSync(path.join(dir, 'calls_' + 'e'.repeat(64) + '.json'), '{broken', 'utf8');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a history file', 'utf8');
    var out = await storeMod.CallHistory.pruneAll(dir, 30);
    assert.strictEqual(out.files, 3, 'legacy + keyed + corrupt counted');
    assert.strictEqual(out.removed, 2, 'two old records removed across partitions');
    assert.strictEqual(new storeMod.CallHistory(dir, kh).list().length, 1, 'keyed partition keeps new record');
  },
  'CallHistory.pruneAll on missing dir is safe': async function () {
    var out = await storeMod.CallHistory.pruneAll(path.join(os.tmpdir(), 'ws7-nope-' + Date.now()), 30);
    assert.deepStrictEqual(out, { files: 0, removed: 0 });
  },
  'MemoryStore.pruneOlderThan removes old entries incl. transcripts': async function () {
    var dir = tmpdir();
    var m = new memoryMod.MemoryStore(dir);
    await m.importAll([
      { id: 'm-old', startedAt: new Date(Date.now() - 50 * DAY).toISOString(), notes: [], transcript: [{ who: 'user', text: 'hi' }] },
      { id: 'm-new', startedAt: new Date().toISOString(), notes: [], transcript: [] }
    ]);
    var removed = await m.pruneOlderThan(30);
    assert.strictEqual(removed, 1);
    var ids = m.list().map(function (e) { return e.id; });
    assert.deepStrictEqual(ids, ['m-new']);
  },
  'MemoryStore.pruneAll prunes legacy + keyed memory partitions': async function () {
    var dir = tmpdir();
    var kh = 'f'.repeat(64);
    var legacy = new memoryMod.MemoryStore(dir);
    await legacy.importAll([{ id: 'ml-old', startedAt: new Date(Date.now() - 90 * DAY).toISOString(), notes: [], transcript: [] }]);
    var keyed = new memoryMod.MemoryStore(dir, kh);
    await keyed.importAll([{ id: 'mk-old', startedAt: new Date(Date.now() - 90 * DAY).toISOString(), notes: [], transcript: [] }]);
    var out = await memoryMod.MemoryStore.pruneAll(dir, 30);
    assert.strictEqual(out.files, 2);
    assert.strictEqual(out.removed, 2);
  }
};
