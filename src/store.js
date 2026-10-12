'use strict';
/**
 * src/store.js — local call-history log for Symbiote Calling.
 *
 * Only metadata is stored: which agent was called, when, and how long the
 * call lasted. No audio, no transcripts. Atomic writes (temp + rename),
 * serialized. Local demo data only — not a secure production system.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function CallHistory(dataDir) {
  this.dataDir = dataDir;
  this.file = path.join(dataDir, 'calls.json');
  this._queue = Promise.resolve();
}

CallHistory.prototype._ensureFile = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '[]\n', 'utf8');
};

CallHistory.prototype._readAll = function () {
  this._ensureFile();
  var raw = fs.readFileSync(this.file, 'utf8');
  var arr;
  try { arr = JSON.parse(raw); } catch (e) { throw new Error('calls.json is corrupt: ' + e.message); }
  if (!Array.isArray(arr)) throw new Error('calls.json must contain an array');
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

/** Clear all history (user-confirmed in the UI). */
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

module.exports = { CallHistory: CallHistory };
