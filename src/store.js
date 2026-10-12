'use strict';
/**
 * src/store.js — local call-history log for Symbiote Calling.
 *
 * Only metadata is stored: which agent was called, when, and how long the
 * call lasted. No audio, no transcripts. Atomic writes (temp + rename),
 * serialized. Local demo data only — not a secure production system.
 *
 * v7 key gating: storage is PER-KEYHASH-PARTITIONED. Construct with the
 * caller's keyHash (sha256 hex of their API key — the key itself is never
 * stored) and this instance reads/writes DATA_DIR/calls_<keyHash>.json, so
 * one key's history can never leak into another's and switching keys never
 * wipes anything. Constructed WITHOUT a keyHash, it keeps the legacy
 * single-file behavior (DATA_DIR/calls.json) — the pre-v7 shared instance
 * used by server.js until the integrator wires per-key instances.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var keystoreMod = require('./keystore');
var cleanupMod = require('./cleanup');

function CallHistory(dataDir, keyHash) {
  this.dataDir = dataDir;
  // scopeKeyHash: when set, this instance reads/writes the per-key partition
  // file; when null, the legacy shared calls.json (see header comment).
  this.scopeKeyHash = keyHash == null ? null : keystoreMod.normalizeKeyHash(keyHash);
  this.file = path.join(dataDir, this.scopeKeyHash ? 'calls_' + this.scopeKeyHash + '.json' : 'calls.json');
  this._queue = Promise.resolve();
}

/** Storage file name for a keyHash (null -> legacy shared file). Exposed for tests/docs. */
CallHistory.fileNameFor = function (keyHash) {
  return keyHash == null ? 'calls.json' : 'calls_' + keystoreMod.normalizeKeyHash(keyHash) + '.json';
};

CallHistory.prototype._ensureFile = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '[]\n', 'utf8');
};

CallHistory.prototype._readAll = function () {
  this._ensureFile();
  var raw = fs.readFileSync(this.file, 'utf8');
  var arr;
  try { arr = JSON.parse(raw); } catch (e) { throw new Error(path.basename(this.file) + ' is corrupt: ' + e.message); }
  if (!Array.isArray(arr)) throw new Error(path.basename(this.file) + ' must contain an array');
  return arr;
};

CallHistory.prototype._atomic = function (fn) {
  var self = this;
  var run = this._queue.then(function () {
    var all = self._readAll();
    var out = fn(all) || {};
    var next = out.next || all;
    var payload = JSON.stringify(next, null, 2) + '\n';
    JSON.parse(payload);
    self._ensureFile();
    var tmp = self.file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, self.file);
    return out.result;
  });
  this._queue = run.catch(function () {});
  return run;
};

CallHistory.prototype.list = function () { return this._readAll(); };

/** Call started (only after the Live session confirms setup). Returns call id. */
CallHistory.prototype.logStart = async function (info) {
  var entry = {
    id: 'call_' + crypto.randomBytes(8).toString('hex'),
    agentId: info.agentId, agentName: info.agentName, number: info.number,
    startedAt: new Date().toISOString(), endedAt: null, durationSec: null
  };
  await this._atomic(function (all) { all.push(entry); return { next: all }; });
  return entry.id;
};

/** Call ended. Idempotent. */
CallHistory.prototype.logEnd = async function (id) {
  await this._atomic(function (all) {
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id && !all[i].endedAt) {
        all[i].endedAt = new Date().toISOString();
        all[i].durationSec = Math.max(0, Math.round((Date.parse(all[i].endedAt) - Date.parse(all[i].startedAt)) / 1000));
      }
    }
    return { next: all };
  });
};

/** Clear history for this instance's scope (one key's partition, or the legacy file). */
CallHistory.prototype.clear = async function () {
  await this._atomic(function () { return { next: [] }; });
};

/**
 * Atomically replace the whole history with `arr` (backup/restore).
 * Non-object entries are skipped. Returns the imported count.
 */
CallHistory.prototype.importAll = async function (arr) {
  if (!Array.isArray(arr)) throw new Error('importAll expects an array');
  var next = arr.filter(function (e) { return e !== null && typeof e === 'object'; });
  await this._atomic(function () { return { next: next }; });
  return next.length;
};

/** Set entry.summary (auto call summary). Truncated to 2000 chars. No-op if id not found. */
CallHistory.prototype.setSummary = async function (id, summary) {
  var text = String(summary).slice(0, 2000);
  await this._atomic(function (all) {
    var e = all.find(function (x) { return x.id === id; });
    if (e) e.summary = text;
    return { next: all };
  });
};

/**
 * v7 auto-cleanup: drop call records whose startedAt is older than `days`.
 * Records with no/invalid startedAt are kept. Returns the removed count.
 */
CallHistory.prototype.pruneOlderThan = async function (days) {
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
 * Prune every history partition under dataDir (legacy calls.json plus all
 * calls_<keyHash>.json). Returns { files, removed }. Never throws on a
 * corrupt partition — it is skipped so one bad file can't block cleanup.
 */
CallHistory.pruneAll = async function (dataDir, days) {
  var out = { files: 0, removed: 0 };
  var names;
  try { names = fs.readdirSync(dataDir); }
  catch (e) { return out; }
  for (var i = 0; i < names.length; i++) {
    if (!/^calls(_[0-9a-f]{64})?\.json$/.test(names[i])) continue;
    out.files++;
    try {
      var h = new CallHistory(dataDir, names[i] === 'calls.json' ? null : names[i].slice(6, -5));
      out.removed += await h.pruneOlderThan(days);
    } catch (e) { /* skip corrupt partition */ }
  }
  return out;
};

module.exports = { CallHistory: CallHistory };
