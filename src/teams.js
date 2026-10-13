'use strict';
/**
 * src/teams.js — v8 #15: agent teams / smart routing.
 *
 * Per-key team config, stored as JSON under DATA_DIR (file teams_<keyHash>.json):
 *   { receptionistAgentId: 'symagent', specialistIds: ['lina', 'ava', ...] }
 *
 * CONSTRAINT (do not "fix" around this in code): transfer_call is a
 * SymAgent-only tool in this codebase (src/live.js toolDeclarations gates it
 * on agentId === 'symagent'). Team routing therefore goes through the
 * receptionist: the receptionist greets the business-line caller, assesses
 * the need, and calls transfer_call to hand the caller to the right
 * specialist. receptionistAgentId defaults to (and is strongly recommended
 * to be) 'symagent'; if a custom agent is chosen as receptionist it simply
 * will not have the transfer_call tool, so routing degrades to the
 * receptionist handling the call itself — the config validator WARNS about
 * this (returned as {warnings}) rather than blocking it.
 *
 * Smart routing is prompt-driven: src/prompt.js injects the team briefing
 * into the receptionist's system instruction, listing the specialists by
 * name/niche so the model can match the caller's need to a specialist.
 */

var fs = require('fs');
var path = require('path');
var keystoreMod = require('./keystore');
var agentsMod = require('./agents');

var DEFAULT_RECEPTIONIST = 'symagent';
var MAX_SPECIALISTS = 20;

/**
 * Validate + normalize a team config. agentExists(id) is an optional
 * lookup (agents.js getById, plus custom agents). Returns
 * { config, warnings } — never silently drops entries; unknowns throw.
 */
function normalizeTeam(raw, agentExists) {
  if (!raw || typeof raw !== 'object') throw new Error('team config must be an object');
  var rec = String(raw.receptionistAgentId == null ? DEFAULT_RECEPTIONIST : raw.receptionistAgentId).trim() || DEFAULT_RECEPTIONIST;
  var warnings = [];
  if (agentExists && !agentExists(rec)) throw new Error('team: unknown receptionist agent "' + rec + '"');
  var list = raw.specialistIds;
  if (list == null) list = [];
  if (!Array.isArray(list)) throw new Error('team: specialistIds must be an array');
  if (list.length > MAX_SPECIALISTS) throw new Error('team: max ' + MAX_SPECIALISTS + ' specialists');
  var seen = {};
  var specialists = [];
  list.forEach(function (id, i) {
    id = String(id).trim();
    if (!id) throw new Error('team: specialistIds[' + i + '] is empty');
    if (seen[id]) throw new Error('team: duplicate specialist "' + id + '"');
    seen[id] = true;
    if (id === rec) throw new Error('team: receptionist cannot also be a specialist');
    if (agentExists && !agentExists(id)) throw new Error('team: unknown specialist id "' + id + '"');
    specialists.push(id);
  });
  if (rec !== DEFAULT_RECEPTIONIST) {
    warnings.push('receptionist "' + rec + '" has no transfer_call tool (SymAgent-only); routing will not work — the receptionist will handle calls itself');
  }
  return { config: { receptionistAgentId: rec, specialistIds: specialists }, warnings: warnings };
}

/** Default team for a key: SymAgent receptionist, no specialists yet. */
function defaultTeam() {
  return { receptionistAgentId: DEFAULT_RECEPTIONIST, specialistIds: [] };
}

/**
 * Specialist briefing lines for the receptionist prompt (name + niche +
 * id, generated from agents.js so it never drifts). `describe(id)` is an
 * optional (id)->{name,niche} lookup (tests inject a stub).
 */
function specialistBriefing(specialistIds, describe) {
  var desc = describe || function (id) {
    var a = agentsMod.getById(id);
    return a ? { name: a.name, niche: a.niche } : null;
  };
  return (specialistIds || []).map(function (id) {
    var d = desc(id);
    if (!d) return null;
    return d.name + ' — ' + d.niche + ' (agent id "' + id + '")';
  }).filter(Boolean);
}

/* ---------------------------------------------------------------------------
 * Per-key JSON store: teams_<keyHash>.json under DATA_DIR.
 * ------------------------------------------------------------------------- */

function TeamStore(dataDir, keyHash) {
  var kh = keystoreMod.normalizeKeyHash(keyHash); // throws on garbage
  this.dataDir = dataDir;
  this.keyHash = kh;
  this.file = path.join(dataDir, 'teams_' + kh + '.json');
}

TeamStore.fileNameFor = function (keyHash) {
  return 'teams_' + keystoreMod.normalizeKeyHash(keyHash) + '.json';
};

TeamStore.prototype._ensureDir = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
};

TeamStore.prototype.get = function () {
  this._ensureDir();
  if (!fs.existsSync(this.file)) return defaultTeam();
  var raw;
  try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  catch (e) { throw new Error('team config corrupt: ' + e.message); }
  return normalizeTeam(raw).config;
};

TeamStore.prototype.save = function (raw, agentExists) {
  this._ensureDir();
  var out = normalizeTeam(raw, agentExists);
  var payload = JSON.stringify(out.config, null, 2) + '\n';
  JSON.parse(payload);
  var tmp = this.file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, this.file);
  return out;
};

module.exports = {
  normalizeTeam: normalizeTeam,
  defaultTeam: defaultTeam,
  specialistBriefing: specialistBriefing,
  TeamStore: TeamStore,
  DEFAULT_RECEPTIONIST: DEFAULT_RECEPTIONIST,
  MAX_SPECIALISTS: MAX_SPECIALISTS
};
