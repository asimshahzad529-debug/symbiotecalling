'use strict';
/**
 * src/memory.js — per-agent call memories for Symbiote Calling.
 *
 * Each finished call becomes a memory entry: agent, time, duration,
 * agent-saved notes (appointments, facts) and the conversation transcript.
 *
 * v7 key gating: storage is PER-KEYHASH-PARTITIONED. Construct with the
 * caller's keyHash (sha256 hex of their API key — the key itself is never
 * stored) and this instance reads/writes DATA_DIR/memories_<keyHash>.json,
 * so one key's memories never leak into another's and switching keys never
 * wipes anything. Constructed WITHOUT a keyHash, it keeps the legacy
 * behavior (single memories.json + keyscope.json with wipe-on-key-change).
 *
 * Atomic writes (temp + rename), serialized. Local demo data only.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var keystoreMod = require('./keystore');
var cleanupMod = require('./cleanup');

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function MemoryStore(dataDir, keyHash) {
  this.dataDir = dataDir;
  // NOTE: named scopeKeyHash (not keyHash) so it does not shadow the
  // MemoryStore.prototype.keyHash(apiKey) helper below.
  this.scopeKeyHash = keyHash == null ? null : keystoreMod.normalizeKeyHash(keyHash);
  this.file = path.join(dataDir, this.scopeKeyHash ? 'memories_' + this.scopeKeyHash + '.json' : 'memories.json');
  this.scopeFile = path.join(dataDir, 'keyscope.json');
  this._queue = Promise.resolve();
}

/** Storage file name for a keyHash (null -> legacy shared file). Exposed for tests/docs. */
MemoryStore.fileNameFor = function (keyHash) {
  return keyHash == null ? 'memories.json' : 'memories_' + keystoreMod.normalizeKeyHash(keyHash) + '.json';
};

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
 * Ensure the scope matches this key.
 *
 * Partitioned instances (constructed WITH a keyHash) are already isolated
 * per key, so this is a no-op that always reports { reset: false } — no
 * wiping, ever. Legacy instances (constructed WITHOUT a keyHash, the
 * pre-v7 shared stores) keep the old behavior: if a different key was used
 * before, wipe memories (caller should also wipe history) and report
 * { reset: true }.
 */
MemoryStore.prototype.ensureScope = async function (keyHash) {
  if (this.scopeKeyHash) return { reset: false };
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

/**
 * Atomically replace all memories with `arr` (backup/restore).
 * Non-object entries are skipped. Returns the imported count.
 */
MemoryStore.prototype.importAll = async function (arr) {
  if (!Array.isArray(arr)) throw new Error('importAll expects an array');
  var next = arr.filter(function (e) { return e !== null && typeof e === 'object'; });
  await this._atomic(function () { return { next: next }; });
  return next.length;
};

/** Set entry.summary (auto call summary). Truncated to 2000 chars. No-op if id not found. */
MemoryStore.prototype.setSummary = async function (id, summary) {
  var text = String(summary).slice(0, 2000);
  await this._atomic(function (all) {
    var e = all.find(function (x) { return x.id === id; });
    if (e) e.summary = text;
    return { next: all };
  });
};

/**
 * v7 auto-cleanup: drop memory entries (notes + transcripts) whose
 * startedAt is older than `days`. Entries with no/invalid startedAt are
 * kept. Returns the removed count.
 */
MemoryStore.prototype.pruneOlderThan = async function (days) {
  var removed = 0;
  await this._atomic(function (all) {
    var fresh = all.filter(function (r) {
      var drop = r && typeof r === 'object' && cleanupMod.isOlderThan(r.startedAt, days);
      if (drop) removed++;
      return !drop;
    });
    return { next: fresh, result: removed };
  });
  return removed;
};

/**
 * Prune every memory partition under dataDir (legacy memories.json plus
 * all memories_<keyHash>.json). Returns { files, removed }. Corrupt
 * partitions are skipped, never fatal.
 */
MemoryStore.pruneAll = async function (dataDir, days) {
  var out = { files: 0, removed: 0 };
  var names;
  try { names = fs.readdirSync(dataDir); }
  catch (e) { return out; }
  for (var i = 0; i < names.length; i++) {
    if (!/^memories(_[0-9a-f]{64})?\.json$/.test(names[i])) continue;
    out.files++;
    try {
      var m = new MemoryStore(dataDir, names[i] === 'memories.json' ? null : names[i].slice(9, -5));
      out.removed += await m.pruneOlderThan(days);
    } catch (e) { /* skip corrupt partition */ }
  }
  return out;
};

module.exports = { MemoryStore: MemoryStore, sha256: sha256 };
