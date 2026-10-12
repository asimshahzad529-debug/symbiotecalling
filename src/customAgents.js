'use strict';
/**
 * src/customAgents.js — user-created custom calling agents (v7, WS2).
 *
 * Custom agents behave like built-ins: they dial, get a Live session, and
 * belong to Symbiote Systems. They are scoped per API key (by SHA-256 hash
 * of the key, via src/bridge.js keyHashOf) — one file per key:
 *   DATA_DIR/custom_<keyHash>.json
 * The key itself is never stored. Built-in agents (src/agents.js) are NOT
 * touched; this module is read-only-safe to merge alongside them.
 *
 * Voice list: listVoices() is derived from the voices already used by the
 * built-in agents in src/agents.js (deduped, sorted). That keeps custom
 * agents guaranteed-compatible with the Live voices the relay supports.
 * If src/live.js ever changes the supported voice set, derive from there
 * instead and update the note below.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var TONES = ['professional', 'friendly', 'confident', 'casual'];
var MAX_NAME = 60;
var MAX_NUMBER = 24;
var MAX_ROLE = 120;
var MAX_PROMPT = 4000;
var MAX_AVATAR_BYTES = 500 * 1024; // ~500KB cap on uploaded avatar data URLs

function isKeyHash(h) { return /^[0-9a-f]{64}$/.test(String(h || '')); }

function knownVoices() {
  var agents;
  try { agents = require('./agents'); } catch (e) { return []; }
  var seen = {};
  agents.list().forEach(function (a) { if (a.voice) seen[a.voice] = 1; });
  return Object.keys(seen).sort();
}

function listVoices() { return knownVoices(); }

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

function digitsOf(number) { return String(number || '').replace(/\D/g, ''); }

/**
 * validate(data) -> { ok:true, value } | { ok:false, error }.
 * value is the cleaned record: { name, number, role, tone, voice, prompt, avatar }.
 * avatar is normalized to { kind: 'upload', dataUrl } or { kind: 'default' }.
 */
function validate(data) {
  data = data || {};
  var name = str(data.name);
  if (!name) return { ok: false, error: 'name is required' };
  if (name.length > MAX_NAME) return { ok: false, error: 'name must be <= ' + MAX_NAME + ' characters' };
  var number = str(data.number);
  if (!number) return { ok: false, error: 'number is required' };
  if (number.length > MAX_NUMBER) return { ok: false, error: 'number must be <= ' + MAX_NUMBER + ' characters' };
  var role = str(data.role);
  if (!role) return { ok: false, error: 'role is required' };
  if (role.length > MAX_ROLE) return { ok: false, error: 'role must be <= ' + MAX_ROLE + ' characters' };
  var tone = str(data.tone) || 'professional';
  if (TONES.indexOf(tone) < 0) return { ok: false, error: 'tone must be one of: ' + TONES.join(', ') };
  var voice = str(data.voice);
  var voices = knownVoices();
  if (voice) {
    if (voices.indexOf(voice) < 0) return { ok: false, error: 'voice must be one of: ' + voices.join(', ') };
  } else {
    voice = voices[0] || 'Charon';
  }
  var prompt = typeof data.prompt === 'string' ? data.prompt : '';
  if (prompt.length > MAX_PROMPT) return { ok: false, error: 'prompt must be <= ' + MAX_PROMPT + ' characters' };
  var avatar = { kind: 'default' };
  if (data.avatar && typeof data.avatar === 'object') {
    if (data.avatar.kind === 'upload') {
      var du = data.avatar.dataUrl;
      if (du === undefined || du === null || du === '') {
        avatar = { kind: 'upload' }; // bytes managed separately (API writes the file)
      } else {
        if (typeof du !== 'string' || !/^data:image\/[a-zA-Z+]+;base64,/.test(du)) {
          return { ok: false, error: 'avatar.dataUrl must be a data:image/*;base64 URL' };
        }
        if (Buffer.byteLength(du, 'utf8') > MAX_AVATAR_BYTES) {
          return { ok: false, error: 'avatar image is too large (max ~500KB)' };
        }
        avatar = { kind: 'upload', dataUrl: du };
      }
    } else if (data.avatar.kind && data.avatar.kind !== 'default') {
      return { ok: false, error: 'avatar.kind must be "upload" or "default"' };
    }
  }
  return { ok: true, value: { name: name, number: number, role: role, tone: tone, voice: voice, prompt: prompt, avatar: avatar } };
}

function CustomAgentStore(dataDir) {
  this.dataDir = dataDir;
  this._queue = Promise.resolve();
}

CustomAgentStore.prototype._fileFor = function (keyHash) {
  if (!isKeyHash(keyHash)) throw new Error('invalid keyHash');
  return path.join(this.dataDir, 'custom_' + keyHash + '.json');
};

CustomAgentStore.prototype._ensureDir = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
};

CustomAgentStore.prototype._readAll = function (keyHash) {
  var file = this._fileFor(keyHash);
  this._ensureDir();
  if (!fs.existsSync(file)) return [];
  var raw = fs.readFileSync(file, 'utf8');
  var v;
  try { v = JSON.parse(raw); } catch (e) { throw new Error('custom agents file is corrupt'); }
  if (!Array.isArray(v)) throw new Error('custom agents file must contain an array');
  return v;
};

CustomAgentStore.prototype._writeAll = function (keyHash, list) {
  var file = this._fileFor(keyHash);
  this._ensureDir();
  var payload = JSON.stringify(list, null, 2) + '\n';
  JSON.parse(payload);
  var tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
};

/** Serialize write op after prior ops (read-your-write ordering). */
CustomAgentStore.prototype._serial = function (fn) {
  var self = this;
  var run = this._queue.then(function () { return fn(); });
  this._queue = run.catch(function () {});
  return run;
};

function randomId() { return 'custom_' + crypto.randomBytes(4).toString('hex'); }

CustomAgentStore.prototype.list = function (keyHash) {
  return this._readAll(keyHash);
};

CustomAgentStore.prototype.get = function (keyHash, id) {
  var list = this._readAll(keyHash);
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
};

CustomAgentStore.prototype.create = async function (keyHash, data) {
  var self = this;
  var v = validate(data);
  if (!v.ok) { var e = new Error(v.error); e.code = 'VALIDATION'; throw e; }
  var id = randomId();
  var rec = Object.assign({ id: id, createdAt: new Date().toISOString(), isCustom: true }, v.value);
  await this._serial(function () {
    var list = self._readAll(keyHash);
    // collision-safe: ids are random, but guard anyway
    while (list.some(function (a) { return a.id === id; })) { rec.id = randomId(); }
    list.push(rec);
    self._writeAll(keyHash, list);
  });
  return rec;
};

CustomAgentStore.prototype.update = async function (keyHash, id, data) {
  var self = this;
  var v = validate(data);
  if (!v.ok) { var e = new Error(v.error); e.code = 'VALIDATION'; throw e; }
  var out = null;
  await this._serial(function () {
    var list = self._readAll(keyHash);
    var idx = list.findIndex(function (a) { return a.id === id; });
    if (idx < 0) { var nf = new Error('custom agent not found'); nf.code = 'NOT_FOUND'; throw nf; }
    var merged = Object.assign({}, v.value);
    if (!data || data.avatar === undefined || data.avatar === null) {
      merged.avatar = list[idx].avatar || { kind: 'default' }; // keep existing avatar when untouched
    }
    var rec = Object.assign({}, list[idx], merged, { id: list[idx].id, createdAt: list[idx].createdAt, isCustom: true });
    list[idx] = rec;
    self._writeAll(keyHash, list);
    out = rec;
  });
  return out;
};

CustomAgentStore.prototype.remove = async function (keyHash, id) {
  var self = this;
  var out = false;
  await this._serial(function () {
    var list = self._readAll(keyHash);
    var next = list.filter(function (a) { return a.id !== id; });
    if (next.length === list.length) { var nf = new Error('custom agent not found'); nf.code = 'NOT_FOUND'; throw nf; }
    self._writeAll(keyHash, next);
    out = true;
  });
  return out;
};

/**
 * cloneFrom(keyHash, sourceAgent) -> pre-filled draft object, NOT saved.
 * sourceAgent must be a built-in agent (from src/agents.js).
 * Custom agents are NOT cloneable — cloning them is rejected here and at
 * the API route (never trust the client).
 */
function cloneFrom(keyHash, sourceAgent) {
  if (!isKeyHash(keyHash)) throw new Error('invalid keyHash');
  if (!sourceAgent || typeof sourceAgent !== 'object') throw new Error('sourceAgent required');
  if (sourceAgent.isCustom === true) throw new Error('custom agents cannot be cloned');
  var v = validate({
    name: sourceAgent.name || '',
    number: sourceAgent.number || '',
    role: sourceAgent.role || sourceAgent.niche || '',
    tone: sourceAgent.tone || 'professional',
    voice: sourceAgent.voice || '',
    prompt: sourceAgent.prompt || '',
    avatar: { kind: 'default' }
  });
  if (!v.ok) throw new Error('cannot clone source agent: ' + v.error);
  v.value.clonedFrom = sourceAgent.id || null;
  return v.value;
}

var TONE_LINES = {
  professional: 'Behave professionally at all times: polite, concise, and businesslike.',
  friendly: 'Be warm and friendly: upbeat, personable, and encouraging.',
  confident: 'Be confident and direct: assured, persuasive, and to the point.',
  casual: 'Be casual and relaxed: conversational, light, and easygoing.'
};

/**
 * toAgent(custom) -> full agent object shaped like built-ins in src/agents.js:
 * { id, name, gender, niche, number, voice, color, tagline, prompt,
 *   isCustom:true, hasAvatarUpload, avatarUrl } so it drops straight into
 * bridge/publicAgent, buildAgentInstruction, and Live session setup.
 */
function toAgent(custom) {
  if (!custom || typeof custom !== 'object') throw new Error('custom agent required');
  var lines = [
    'You are ' + custom.name + ', a ' + custom.role + ' voice calling agent by Symbiote Systems.',
    TONE_LINES[custom.tone] || TONE_LINES.professional
  ];
  if (custom.prompt) lines.push(custom.prompt);
  lines.push(
    'You are one assistant role-playing this agent for the call — not a licensed professional, not a separately trained model.',
    'Follow the role limits in your description exactly (no diagnosis, no legal advice, no transactions, no secrets, no therapy).',
    'This is a demo calling system, not an emergency service.'
  );
  var hasUpload = !!(custom.avatar && custom.avatar.kind === 'upload');
  return {
    id: custom.id,
    name: custom.name,
    gender: null, // custom agents have no fixed gender; buildAgentInstruction skips the gender line
    niche: custom.role,
    role: custom.role,
    number: custom.number,
    voice: custom.voice,
    color: '#7c3aed',
    tagline: custom.role,
    prompt: lines.join('\n'),
    rawPrompt: custom.prompt || '',
    isCustom: true,
    hasAvatarUpload: hasUpload,
    avatarUrl: hasUpload ? '/api/v7/custom-agents/' + encodeURIComponent(custom.id) + '/avatar' : null
  };
}

/** Public (client-safe) view of one custom agent record. */
function publicCustomAgent(custom) {
  var a = toAgent(custom);
  return {
    id: a.id, name: a.name, number: a.number, role: a.role, tone: custom.tone,
    voice: a.voice, prompt: custom.prompt || '', isCustom: true,
    hasAvatarUpload: a.hasAvatarUpload, avatarUrl: a.avatarUrl,
    createdAt: custom.createdAt || null
  };
}

/** Find one custom agent by id or number (digit-normalized), -> toAgent or null. */
function findTarget(store, keyHash, idOrNumber) {
  if (!store || !isKeyHash(keyHash)) return null;
  var q = String(idOrNumber || '').trim();
  if (!q) return null;
  var list;
  try { list = store.list(keyHash); } catch (e) { return null; }
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === q) return toAgent(list[i]);
  }
  var d = digitsOf(q);
  if (d) {
    var want = d.slice(-10);
    for (var j = 0; j < list.length; j++) {
      if (digitsOf(list[j].number).slice(-10) === want) return toAgent(list[j]);
    }
  }
  return null;
}

/** Markdown-ish text block of custom agents for SymAgent's directory section. */
function directorySection(list) {
  list = list || [];
  if (!list.length) return '';
  var lines = [
    'CUSTOM AGENTS — created by the user on this platform (they also belong to Symbiote Systems, and you know every one of them):'
  ];
  list.forEach(function (c) {
    lines.push('- ' + c.name + ' (' + (c.role || c.niche || 'agent') + ', ' + c.number + ', id: ' + c.id + ')');
  });
  lines.push('If asked about a specific custom agent, explain what it does from its role and give its full number.');
  return lines.join('\n');
}

module.exports = {
  CustomAgentStore: CustomAgentStore,
  validate: validate,
  cloneFrom: cloneFrom,
  toAgent: toAgent,
  publicCustomAgent: publicCustomAgent,
  findTarget: findTarget,
  directorySection: directorySection,
  listVoices: listVoices,
  TONES: TONES,
  isKeyHash: isKeyHash,
  MAX_AVATAR_BYTES: MAX_AVATAR_BYTES
};
