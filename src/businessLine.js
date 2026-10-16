'use strict';
/**
 * src/businessLine.js — v8 #26: per-key virtual business line.
 *
 * Every API key (identified by its sha256 keyHash — the raw key is NEVER
 * stored) gets its own FICTIONAL front-door number, e.g.
 * "+1 (555) 014-2093". The number is derived deterministically from the
 * keyHash, so it is stable across restarts and needs no database row.
 *
 * The 101 built-in agents use the +1 (555) 010-0001..010-0100 block, so the
 * business-line block uses a DIFFERENT exchange — 014 — which makes a
 * collision structurally impossible (010 != 014).
 *
 * All numbers here are fictional. There is no PSTN, no real telephony, no
 * calling or receiving of real phone calls. UNVERIFIED-LIVE: the whole
 * business line is a demo surface until a real telephony provider is
 * wired in.
 *
 * TELEPHONY PROVIDER CONTRACT (for a future real provider):
 * A provider object must implement:
 *   async provisionNumber(keyHash) -> { number }    // allocate/claim a number for this key
 *   async releaseNumber(keyHash)                    // release it (no-op allowed)
 *   async sendStatus(…)                             // optional, unused by core
 * FictionalTelephony implements the contract deterministically and
 * synchronously; a real provider (Twilio, Plivo, …) can implement the same
 * two methods and plug in without touching the rest of the code. The
 * missed-call log below is provider-agnostic.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var keystoreMod = require('./keystore');

var AREA = '555';
var EXCHANGE = '014'; // deliberately NOT 010 — built-in agents own the 010 block

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/**
 * Deterministic fictional business-line number for a keyHash.
 * Returns "+1 (555) 014-XXXX" where XXXX is derived from sha256(keyHash).
 * Pure function: same keyHash -> same number, always.
 */
function numberForKeyHash(keyHash) {
  var kh = keystoreMod.normalizeKeyHash(keyHash); // throws on garbage
  var digest = sha256Hex('symbiote-business-line:' + kh);
  // 4 hex digits -> 0..65535 -> 4-digit line number, zero-padded.
  var line = parseInt(digest.slice(0, 4), 16) % 10000;
  var lineStr = ('0000' + line).slice(-4);
  return '+1 (' + AREA + ') ' + EXCHANGE + '-' + lineStr;
}

/** True when a number is one of the 103 built-in agent numbers (+1 (555) 010-00XX). */
function isBuiltInAgentNumber(number) {
  return typeof number === 'string' && /^\+1 \(555\) 010-0\d{3}$/.test(number);
}

/** True when a number is a business-line number (the 014 exchange block). */
function isBusinessLineNumber(number) {
  return typeof number === 'string' && /^\+1 \(555\) 014-\d{4}$/.test(number);
}

/**
 * Fictional telephony provider: implements the provider contract with no
 * external calls. provisionNumber is deterministic — calling it twice for
 * the same keyHash returns the same number.
 */
var FictionalTelephony = {
  name: 'fictional',
  async provisionNumber(keyHash) {
    return { number: numberForKeyHash(keyHash) };
  },
  async releaseNumber(/* keyHash */) {
    return { ok: true };
  }
};

/* ---------------------------------------------------------------------------
 * Missed-call log — per-key JSON under DATA_DIR, same storage pattern as
 * src/store.js (atomic temp+rename writes, serialized queue).
 * File: missed_<keyHash>.json. Entries: {id, from, at, reason}.
 * ------------------------------------------------------------------------- */

function MissedCallStore(dataDir, keyHash) {
  var kh = keystoreMod.normalizeKeyHash(keyHash); // throws on garbage
  this.dataDir = dataDir;
  this.keyHash = kh;
  this.file = path.join(dataDir, 'missed_' + kh + '.json');
  this._queue = Promise.resolve();
}

MissedCallStore.fileNameFor = function (keyHash) {
  return 'missed_' + keystoreMod.normalizeKeyHash(keyHash) + '.json';
};

MissedCallStore.prototype._ensureFile = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '[]\n', 'utf8');
};

MissedCallStore.prototype._readAll = function () {
  this._ensureFile();
  var arr;
  try { arr = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  catch (e) { throw new Error(path.basename(this.file) + ' is corrupt: ' + e.message); }
  if (!Array.isArray(arr)) throw new Error(path.basename(this.file) + ' must contain an array');
  return arr;
};

MissedCallStore.prototype._atomic = function (fn) {
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

MissedCallStore.prototype.list = function () { return this._readAll(); };

/** Append a missed-call entry. `from` is a display string (fictional). */
MissedCallStore.prototype.log = async function (from, reason) {
  var entry = {
    id: 'mc_' + crypto.randomBytes(8).toString('hex'),
    from: String(from || 'unknown').slice(0, 80),
    at: new Date().toISOString(),
    reason: String(reason || 'no-answer').slice(0, 40)
  };
  await this._atomic(function (all) { all.unshift(entry); return { next: all }; });
  return entry.id;
};

MissedCallStore.prototype.clear = async function () {
  await this._atomic(function () { return { next: [] }; });
};

var NO_ANSWER_MS = 30000;

/**
 * Track one business-line inbound call. If neither answered() nor ended()
 * is called within 30s, the call is logged as a missed call with
 * reason 'no-answer'. Timers are injectable for tests.
 *
 * opts: { dataDir, keyHash, from, setTimer?, clearTimer? }
 * Returns { answered(), ended(), isDone(), loggedMissed() }.
 */
function trackInboundCall(opts) {
  opts = opts || {};
  var setTimer = opts.setTimer || setTimeout;
  var clearTimer = opts.clearTimer || clearTimeout;
  var store = new MissedCallStore(opts.dataDir || '.', opts.keyHash);
  var done = false;
  var missed = false;
  var timer = setTimer(function () {
    timer = null;
    if (done) return;
    done = true;
    missed = true;
    store.log(opts.from || 'unknown', 'no-answer').catch(function () {});
  }, NO_ANSWER_MS);

  function settle() {
    if (timer) { clearTimer(timer); timer = null; }
    done = true;
  }
  return {
    answered: function () { settle(); },
    ended: function () { settle(); },
    isDone: function () { return done; },
    loggedMissed: function () { return missed; },
    // exposed for the API layer; do not call from session code
    _store: store
  };
}

module.exports = {
  numberForKeyHash: numberForKeyHash,
  isBuiltInAgentNumber: isBuiltInAgentNumber,
  isBusinessLineNumber: isBusinessLineNumber,
  FictionalTelephony: FictionalTelephony,
  MissedCallStore: MissedCallStore,
  trackInboundCall: trackInboundCall,
  NO_ANSWER_MS: NO_ANSWER_MS,
  AREA: AREA,
  EXCHANGE: EXCHANGE
};
