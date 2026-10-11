'use strict';
/**
 * src/memory.js — per-agent call memories for Symbiote Calling.
 *
 * Each finished call becomes a memory entry: agent, time, duration,
 * agent-saved notes (appointments, facts) and the conversation transcript.
 * Memories are scoped to the API key in use (by SHA-256 hash — the key
 * itself is never stored). If the key changes, all memories AND call
 * history are wiped so one key's data never leaks into another's.
 *
 * Atomic writes (temp + rename), serialized. Local demo data only.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function MemoryStore(dataDir) {
  this.dataDir = dataDir;
  this.file = path.join(dataDir, 'memories.json');
  this.scopeFile = path.join(dataDir, 'keyscope.json');
  this._queue = Promise.resolve();
}

MemoryStore.prototype._ensure = function (file, def) {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, def, 'utf8');
};

MemoryStore.prototype._readJson = function (file, def) {
  this._ensure(file, def);
  var raw = fs.readFileSync(file, 'utf8');
  var v;
  try { v = JSON.parse(raw); } catch (e) { throw new Error(path.basename(file) + ' is corrupt: ' + e.message); }
  return v;
};

MemoryStore.prototype._atomic = function (fn) {
  var self = this;
  var run = this._queue.then(function () {
    var all = self._readJson(self.file, '[]');
    if (!Array.isArray(all)) throw new Error('memories.json must contain an array');
    var out = fn(all) || {};
    var next = out.next || all;
    var payload = JSON.stringify(next, null, 2) + '\n';
    JSON.parse(payload);
    self._ensure(self.file, '[]');
    var tmp = self.file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, self.file);
    return out.result;
  });
  this._queue = run.catch(function () {});
  return run;
};

/** Current key scope hash, or null if none stored yet. */
MemoryStore.prototype.getScope = function () {
  var v = this._readJson(this.scopeFile, 'null');
  return v && v.keyHash ? v.keyHash : null;
};

MemoryStore.prototype.setScope = function (keyHash) {
  this._ensure(this.scopeFile, 'null');
  fs.writeFileSync(this.scopeFile, JSON.stringify({ keyHash: keyHash, setAt: new Date().toISOString() }) + '\n', 'utf8');
};

MemoryStore.prototype.keyHash = function (apiKey) { return sha256(apiKey); };

/**
 * Ensure the scope matches this key. If a different key was used before,
 * wipe memories (caller should also wipe history). Returns {reset:boolean}.
 */
MemoryStore.prototype.ensureScope = async function (keyHash) {
  var prev = this.getScope();
  if (prev && prev !== keyHash) {
    await this._atomic(function () { return { next: [] }; });
    this.setScope(keyHash);
    return { reset: true };
  }
  if (!prev) this.setScope(keyHash);
  return { reset: false };
};

/** A call started (after Live setup confirms). Returns memory id. */
MemoryStore.prototype.beginCall = async function (info) {
  var entry = {
    id: 'mem_' + crypto.randomBytes(8).toString('hex'),
    keyHash: info.keyHash,
    agentId: info.agentId, agentName: info.agentName, number: info.number,
    startedAt: new Date().toISOString(), endedAt: null, durationSec: null,
    notes: [], transcript: []
  };
  await this._atomic(function (all) { all.push(entry); return { next: all }; });
  return entry.id;
};

MemoryStore.prototype.addNote = async function (id, note) {
  await this._atomic(function (all) {
    var e = all.find(function (x) { return x.id === id; });
    if (e) e.notes.push({ t: new Date().toISOString(), text: String(note).slice(0, 500) });
    return { next: all };
  });
};

MemoryStore.prototype.appendTranscript = async function (id, who, text) {
  var t = String(text || '').trim();
  if (!t) return;
  await this._atomic(function (all) {
    var e = all.find(function (x) { return x.id === id; });
    if (e) e.transcript.push({ who: who === 'user' ? 'user' : 'agent', text: t.slice(0, 2000), t: new Date().toISOString() });
    return { next: all };
  });
};

/** Call finished. Idempotent. */
MemoryStore.prototype.endCall = async function (id) {
  await this._atomic(function (all) {
    var e = all.find(function (x) { return x.id === id; });
    if (e && !e.endedAt) {
      e.endedAt = new Date().toISOString();
      e.durationSec = Math.max(0, Math.round((Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 1000));
    }
    return { next: all };
  });
};

/** Recent memories for an agent under this key, newest first. Summaries only. */
MemoryStore.prototype.recall = function (agentId, keyHash, limit) {
  var all = this._readJson(this.file, '[]');
  return all
    .filter(function (e) { return e.agentId === agentId && e.keyHash === keyHash && e.endedAt; })
    .sort(function (a, b) { return Date.parse(b.startedAt) - Date.parse(a.startedAt); })
    .slice(0, limit || 3)
    .map(function (e) {
      return {
        id: e.id, startedAt: e.startedAt, durationSec: e.durationSec,
        notes: e.notes.map(function (n) { return n.text; }),
        turns: e.transcript.length
      };
    });
};

MemoryStore.prototype.list = function (keyHash) {
  var all = this._readJson(this.file, '[]');
  return all
    .filter(function (e) { return !keyHash || e.keyHash === keyHash; })
    .sort(function (a, b) { return Date.parse(b.startedAt) - Date.parse(a.startedAt); })
    .map(function (e) {
      return {
        id: e.id, agentId: e.agentId, agentName: e.agentName, number: e.number,
        startedAt: e.startedAt, endedAt: e.endedAt, durationSec: e.durationSec,
        notes: e.notes, noteCount: e.notes.length, turns: e.transcript.length
      };
    });
};

MemoryStore.prototype.get = function (id) {
  var all = this._readJson(this.file, '[]');
  return all.find(function (e) { return e.id === id; }) || null;
};

MemoryStore.prototype.remove = async function (id) {
  await this._atomic(function (all) { return { next: all.filter(function (e) { return e.id !== id; }) }; });
};

MemoryStore.prototype.clear = async function () {
  await this._atomic(function () { return { next: [] }; });
};

module.exports = { MemoryStore: MemoryStore, sha256: sha256 };
