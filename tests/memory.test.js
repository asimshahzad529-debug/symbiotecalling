'use strict';
/* tests/memory.test.js — per-agent call memories + key scoping. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var memoryMod = require('../src/memory');

function tmpMemory() { return new memoryMod.MemoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'))); }

module.exports = {
  'full call lifecycle: begin, note, transcript, end': async function () {
    var m = tmpMemory();
    var kh = m.keyHash('KEY-A');
    var id = await m.beginCall({ keyHash: kh, agentId: 'harper', agentName: 'Harper', number: '+1 (555) 010-0004' });
    await m.addNote(id, 'Dental appointment booked for Oct 15, 3pm');
    await m.appendTranscript(id, 'user', 'I need a dentist appointment');
    await m.appendTranscript(id, 'agent', 'Done, Oct 15 at 3pm');
    await new Promise(function (r) { setTimeout(r, 1100); });
    await m.endCall(id);
    var got = m.get(id);
    assert.strictEqual(got.notes.length, 1);
    assert.ok(got.notes[0].text.indexOf('Oct 15') !== -1);
    assert.strictEqual(got.transcript.length, 2);
    assert.ok(got.endedAt && got.durationSec >= 1);
    await m.endCall(id); // idempotent
    assert.strictEqual(m.get(id).transcript.length, 2);
  },
  'recall returns newest-first summaries for the right agent+key': async function () {
    var m = tmpMemory();
    var kh = m.keyHash('KEY-A'), other = m.keyHash('KEY-B');
    var id1 = await m.beginCall({ keyHash: kh, agentId: 'mia', agentName: 'Mia', number: 'x' });
    await m.addNote(id1, 'first note'); await m.endCall(id1);
    await new Promise(function (r) { setTimeout(r, 15); });
    var id2 = await m.beginCall({ keyHash: kh, agentId: 'mia', agentName: 'Mia', number: 'x' });
    await m.addNote(id2, 'second note'); await m.endCall(id2);
    var id3 = await m.beginCall({ keyHash: other, agentId: 'mia', agentName: 'Mia', number: 'x' });
    await m.addNote(id3, 'other key note'); await m.endCall(id3);
    var rec = m.recall('mia', kh, 3);
    assert.strictEqual(rec.length, 2);
    assert.ok(rec[0].notes[0].indexOf('second') !== -1, 'newest first');
    assert.strictEqual(m.recall('ava', kh, 3).length, 0, 'other agent excluded');
  },
  'key change wipes memories (ensureScope reset)': async function () {
    var m = tmpMemory();
    var khA = m.keyHash('KEY-A');
    var r1 = await m.ensureScope(khA);
    assert.strictEqual(r1.reset, false);
    var id = await m.beginCall({ keyHash: khA, agentId: 'ava', agentName: 'Ava', number: 'x' });
    await m.endCall(id);
    assert.strictEqual(m.list(khA).length, 1);
    var r2 = await m.ensureScope(m.keyHash('KEY-B'));
    assert.strictEqual(r2.reset, true);
    assert.strictEqual(m.list().length, 0, 'memories wiped on key change');
    assert.strictEqual(m.getScope(), m.keyHash('KEY-B'));
  },
  'list hides other-key memories; remove + clear work': async function () {
    var m = tmpMemory();
    var khA = m.keyHash('KEY-A'), khB = m.keyHash('KEY-B');
    var idA = await m.beginCall({ keyHash: khA, agentId: 'ava', agentName: 'Ava', number: 'x' });
    await m.endCall(idA);
    var idB = await m.beginCall({ keyHash: khB, agentId: 'ava', agentName: 'Ava', number: 'x' });
    await m.endCall(idB);
    assert.strictEqual(m.list(khA).length, 1);
    assert.strictEqual(m.list(khB).length, 1);
    await m.remove(idA);
    assert.strictEqual(m.list(khA).length, 0);
    await m.clear();
    assert.strictEqual(m.list().length, 0);
  },
  'key itself is never stored — only its hash': async function () {
    var m = tmpMemory();
    await m.ensureScope(m.keyHash('super-secret-key-123'));
    var id = await m.beginCall({ keyHash: m.keyHash('super-secret-key-123'), agentId: 'ava', agentName: 'Ava', number: 'x' });
    await m.endCall(id);
    var rawScope = fs.readFileSync(path.join(m.dataDir, 'keyscope.json'), 'utf8');
    var rawMem = fs.readFileSync(m.file, 'utf8');
    assert.ok(rawScope.indexOf('super-secret-key-123') === -1, 'raw key must not appear in scope file');
    assert.ok(rawMem.indexOf('super-secret-key-123') === -1, 'raw key must not appear in memories');
  }
};
