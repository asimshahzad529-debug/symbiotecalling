'use strict';
/**
 * src/keystore.js — v7 key profiles, usage metering, concurrent-call rate
 * limiting, and the audit log for Symbiote Calling.
 *
 * Key gating: the whole app sits behind the user's Gemini API key. The key
 * itself is NEVER stored — only its SHA-256 hex hash (64 chars). A user can
 * keep several keys as named "profiles" and switch between them; each
 * profile's calls/history/memories live in their own per-keyHash storage
 * files (see src/store.js and src/memory.js), so switching keys never wipes
 * anything.
 *
 * Files (all under DATA_DIR, atomic temp+rename writes, serialized):
 *   keyprofiles.json — [{ keyHash, label, createdAt }]
 *   usage.json       — { keyHash: { calls, minutes } }
 *   audit.json       — [{ t, keyHash, label, event, agentId }] (newest first, capped)
 *
 * The concurrent-call rate limiter is intentionally IN-MEMORY only: it is a
 * live capacity guard (default max 3 concurrent calls per key), not durable
 * state. A server restart simply resets the counters.
 */

var fs = require('fs');
var path = require('path');

var KEYHASH_RE = /^[0-9a-f]{64}$/;
var DEFAULT_MAX_CONCURRENT = 3;
var MAX_AUDIT_ENTRIES = 500;
var MAX_LABEL_LEN = 80;

function isValidKeyHash(h) {
  return typeof h === 'string' && KEYHASH_RE.test(h);
}

/** Validate and normalize a keyHash to lowercase hex; throws on garbage. */
function normalizeKeyHash(h) {
  if (typeof h === 'string' && /^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
  throw new Error('keyHash must be 64 hex chars');
}

function KeyStore(dataDir, opts) {
  opts = opts || {};
  this.dataDir = dataDir;
  this.maxConcurrent = typeof opts.maxConcurrent === 'number' && opts.maxConcurrent >= 1
    ? Math.floor(opts.maxConcurrent) : DEFAULT_MAX_CONCURRENT;
  this.maxAuditEntries = typeof opts.maxAuditEntries === 'number' && opts.maxAuditEntries >= 1
    ? Math.floor(opts.maxAuditEntries) : MAX_AUDIT_ENTRIES;
  this.profilesFile = path.join(dataDir, 'keyprofiles.json');
  this.usageFile = path.join(dataDir, 'usage.json');
  this.auditFile = path.join(dataDir, 'audit.json');
  this._queue = Promise.resolve();
  this._active = {}; // keyHash -> number of live calls (in-memory only)
}

KeyStore.prototype._ensureDir = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
};

KeyStore.prototype._read = function (file, def) {
  this._ensureDir();
  if (!fs.existsSync(file)) return def;
  var raw = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(path.basename(file) + ' is corrupt: ' + e.message); }
};

KeyStore.prototype._atomicWrite = function (file, value) {
  this._ensureDir();
  var payload = JSON.stringify(value, null, 2) + '\n';
  JSON.parse(payload);
  var tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
};

/** Serialized read-modify-write over one JSON file. fn(doc)->nextDoc|{next,result}. */
KeyStore.prototype._atomic = function (file, def, fn) {
  var self = this;
  var run = this._queue.then(function () {
    var doc = self._read(file, def);
    var out = fn(doc) || {};
    var next = (out && out.next !== undefined) ? out.next : doc;
    self._atomicWrite(file, next);
    return out.result;
  });
  this._queue = run.catch(function () {});
  return run;
};

/* ---------------- key profiles ---------------- */

/** All profiles, oldest first. [{ keyHash, label, createdAt }] */
KeyStore.prototype.listProfiles = function () {
  var arr = this._read(this.profilesFile, []);
  return Array.isArray(arr) ? arr.slice() : [];
};

/**
 * Add or update a profile. label is required-ish: empty/missing falls back
 * to "Key N". Returns the stored profile.
 */
KeyStore.prototype.addProfile = async function (keyHash, label) {
  var kh = normalizeKeyHash(keyHash);
  var name = String(label == null ? '' : label).trim().slice(0, MAX_LABEL_LEN);
  var self = this;
  return this._atomic(this.profilesFile, [], function (arr) {
    if (!Array.isArray(arr)) arr = [];
    if (!name) name = 'Key ' + (arr.length + 1);
    var now = new Date().toISOString();
    var existing = null;
    var next = arr.map(function (p) {
      if (p && p.keyHash === kh) {
        existing = { keyHash: kh, label: name, createdAt: p.createdAt || now };
        return existing;
      }
      return p;
    });
    if (!existing) {
      existing = { keyHash: kh, label: name, createdAt: now };
      next.push(existing);
    }
    return { next: next, result: existing };
  });
};

/** Remove a profile (idempotent). Returns true if one was removed. */
KeyStore.prototype.removeProfile = async function (keyHash) {
  var kh = normalizeKeyHash(keyHash);
  return this._atomic(this.profilesFile, [], function (arr) {
    if (!Array.isArray(arr)) arr = [];
    var before = arr.length;
    var next = arr.filter(function (p) { return !p || p.keyHash !== kh; });
    return { next: next, result: next.length < before };
  });
};

/* ---------------- usage metering ---------------- */

/** { calls, minutes } for a key; zeros when never seen. */
KeyStore.prototype.getUsage = function (keyHash) {
  var kh = normalizeKeyHash(keyHash);
  var doc = this._read(this.usageFile, {});
  var u = (doc && doc[kh]) || {};
  return {
    calls: typeof u.calls === 'number' ? u.calls : 0,
    minutes: typeof u.minutes === 'number' ? u.minutes : 0
  };
};

/** Record one finished call. minutes may be fractional; negatives clamp to 0. */
KeyStore.prototype.recordCall = async function (keyHash, minutes) {
  var kh = normalizeKeyHash(keyHash);
  var mins = typeof minutes === 'number' && isFinite(minutes) ? Math.max(0, minutes) : 0;
  var self = this;
  return this._atomic(this.usageFile, {}, function (doc) {
    if (!doc || typeof doc !== 'object') doc = {};
    var u = doc[kh] || { calls: 0, minutes: 0 };
    doc[kh] = { calls: (u.calls || 0) + 1, minutes: (u.minutes || 0) + mins };
    return { next: doc, result: doc[kh] };
  });
};

/* ---------------- concurrent-call rate limiter (in-memory) ---------------- */

/**
 * Try to start a call for this key. Returns true when admitted, false when
 * the key already has maxConcurrent live calls. Throws on bad keyHash.
 */
KeyStore.prototype.tryAcquire = function (keyHash) {
  var kh = normalizeKeyHash(keyHash);
  var n = this._active[kh] || 0;
  if (n >= this.maxConcurrent) return false;
  this._active[kh] = n + 1;
  return true;
};

/** A call finished (or never started). Returns the remaining live count. */
KeyStore.prototype.release = function (keyHash) {
  var kh = normalizeKeyHash(keyHash);
  var n = Math.max(0, (this._active[kh] || 0) - 1);
  if (n === 0) delete this._active[kh]; else this._active[kh] = n;
  return n;
};

/** Live call count for a key (0 when none). */
KeyStore.prototype.activeCalls = function (keyHash) {
  var kh = normalizeKeyHash(keyHash);
  return this._active[kh] || 0;
};

/* ---------------- audit log ---------------- */

/**
 * Append an audit entry { t, keyHash, label, event, agentId }.
 * event is a short string like 'login' | 'call_start' | 'call_end' |
 * 'profile_add' | 'profile_remove'. agentId may be null.
 */
KeyStore.prototype.audit = async function (entry) {
  var e = entry || {};
  var kh = normalizeKeyHash(e.keyHash);
  var label = String(e.label == null ? '' : e.label).slice(0, MAX_LABEL_LEN);
  var event = String(e.event == null ? '' : e.event).slice(0, 40);
  var agentId = e.agentId == null ? null : String(e.agentId).slice(0, 64);
  var rec = { t: new Date().toISOString(), keyHash: kh, label: label, event: event, agentId: agentId };
  var self = this;
  await this._atomic(this.auditFile, [], function (arr) {
    if (!Array.isArray(arr)) arr = [];
    var next = [rec].concat(arr).slice(0, self.maxAuditEntries);
    return { next: next };
  });
  return rec;
};

/** Recent audit entries, newest first. limit defaults to 100. */
KeyStore.prototype.auditList = function (limit) {
  var n = typeof limit === 'number' && limit >= 1 ? Math.floor(limit) : 100;
  var arr = this._read(this.auditFile, []);
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, n);
};

module.exports = {
  KeyStore: KeyStore,
  isValidKeyHash: isValidKeyHash,
  normalizeKeyHash: normalizeKeyHash,
  DEFAULT_MAX_CONCURRENT: DEFAULT_MAX_CONCURRENT,
  MAX_AUDIT_ENTRIES: MAX_AUDIT_ENTRIES
};
