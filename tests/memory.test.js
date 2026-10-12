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
  'per-key partitions: key switch never wipes, data stays isolated': async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
    var khA = 'a'.repeat(64), khB = 'b'.repeat(64);
    var mA = new memoryMod.MemoryStore(dir, khA);
    var id = await mA.beginCall({ keyHash: khA, agentId: 'ava', agentName: 'Ava', number: 'x' });
    await mA.endCall(id);
    assert.strictEqual(mA.list(khA).length, 1);
    var r1 = await mA.ensureScope(khA);
    assert.strictEqual(r1.reset, false, 'partitioned store never wipes');
    // a different key gets its own empty partition — nothing is destroyed
    var mB = new memoryMod.MemoryStore(dir, khB);
    assert.strictEqual(mB.list(khB).length, 0, 'different key sees separate empty data');
    var r2 = await mB.ensureScope(khB);
    assert.strictEqual(r2.reset, false, 'no wipe on key switch');
    await mB.beginCall({ keyHash: khB, agentId: 'ava', agentName: 'Ava', number: 'x' });
    // switching back: the original data is intact
    var mA2 = new memoryMod.MemoryStore(dir, khA);
    assert.strictEqual(mA2.list(khA).length, 1, 'original key data intact after switch');
    assert.strictEqual(new memoryMod.MemoryStore(dir, khB).list(khB).length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'memories_' + khA + '.json')), 'partitioned file');
    assert.ok(!fs.existsSync(path.join(dir, 'memories.json')), 'no legacy shared file touched');
  },
  'legacy constructor keeps old single-file behavior (no keyHash)': async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
    var m = new memoryMod.MemoryStore(dir);
    var id = await m.beginCall({ keyHash: 'c'.repeat(64), agentId: 'ava', agentName: 'Ava', number: 'x' });
    await m.endCall(id);
    assert.ok(fs.existsSync(path.join(dir, 'memories.json')), 'legacy file name kept');
    assert.strictEqual(m.list().length, 1);
  },
  'constructor rejects malformed keyHash': async function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
    assert.throws(function () { new memoryMod.MemoryStore(dir, 'not-a-hash'); }, /64 hex/);
    assert.throws(function () { new memoryMod.MemoryStore(dir, 'a'.repeat(63)); }, /64 hex/);
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
  'setCallId links a history call id onto a memory entry': async function () {
    var m = tmpMemory();
    var kh = m.keyHash('KEY-A');
    var id = await m.beginCall({ keyHash: kh, agentId: 'ava', agentName: 'Ava', number: 'x' });
    assert.strictEqual(m.get(id).callId, undefined, 'no callId before linking');
    await m.setCallId(id, 'call_abc123');
    assert.strictEqual(m.get(id).callId, 'call_abc123');
    await m.setCallId(id, 'call_abc123'); // idempotent
    assert.strictEqual(m.get(id).callId, 'call_abc123');
    await m.setCallId('does-not-exist', 'call_zzz'); // no-op, must not throw
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
