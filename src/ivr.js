'use strict';
/**
 * src/ivr.js — v8 #13: IVR call menu for the per-key business line.
 *
 * Per-key config, stored as JSON under DATA_DIR (file ivr_<keyHash>.json):
 *   { menu: [ { digit: '1', label: 'Sales', agentId: 'lina' }, ... ],
 *     defaultAgentId: 'symagent' }
 *
 * The menu is spoken to the caller on a business-line inbound call; the
 * caller presses a digit (DTMF) and is routed to the mapped agent, reusing
 * the transfer_call machinery in src/live.js. If no digit is pressed before
 * the menu times out, the call routes to defaultAgentId.
 *
 * All pure logic (validation, prompt building, digit resolution) is
 * exported and unit-tested; the live wiring lives in src/live.js.
 */

var fs = require('fs');
var path = require('path');
var keystoreMod = require('./keystore');

var MENU_TIMEOUT_MS = 45000; // no digit -> route to defaultAgentId

/**
 * Validate an IVR config. Returns a normalized copy:
 *   { menu: [{digit,label,agentId}], defaultAgentId }
 * Throws on garbage. `agentExists(id)` is an optional (id)->bool lookup
 * (agents.js getById in production; omitted in tests).
 */
function normalizeConfig(raw, agentExists) {
  if (!raw || typeof raw !== 'object') throw new Error('ivr config must be an object');
  var menu = raw.menu;
  if (!Array.isArray(menu) || menu.length === 0) throw new Error('ivr menu needs at least one item');
  if (menu.length > 10) throw new Error('ivr menu: max 10 items');
  var seen = {};
  var items = menu.map(function (it, i) {
    if (!it || typeof it !== 'object') throw new Error('ivr menu item ' + i + ' must be an object');
    var digit = String(it.digit == null ? '' : it.digit).trim();
    if (!/^[0-9]$/.test(digit)) throw new Error('ivr menu item ' + i + ': digit must be 0-9');
    if (seen[digit]) throw new Error('ivr menu: duplicate digit "' + digit + '"');
    seen[digit] = true;
    var agentId = String(it.agentId == null ? '' : it.agentId).trim();
    if (!agentId) throw new Error('ivr menu item ' + i + ': agentId required');
    if (agentExists && !agentExists(agentId)) throw new Error('ivr menu item ' + i + ': unknown agent id "' + agentId + '"');
    return { digit: digit, label: String(it.label || '').trim() || agentId, agentId: agentId };
  });
  var def = String(raw.defaultAgentId == null ? '' : raw.defaultAgentId).trim();
  if (!def) throw new Error('ivr config: defaultAgentId required');
  if (agentExists && !agentExists(def)) throw new Error('ivr config: unknown defaultAgentId "' + def + '"');
  return { menu: items, defaultAgentId: def };
}

/**
 * Spoken menu prompt (bilingual Roman Urdu/English, matching project
 * voice). Example:
 *   "Symbiote Systems. Sales ke liye 1 dabayein, Support ke liye 2 dabayein…"
 */
function buildMenuPrompt(config) {
  var menu = config && config.menu;
  if (!Array.isArray(menu) || !menu.length) return 'Press 1 to continue.';
  var parts = menu.map(function (it) {
    return it.label + ' ke liye ' + it.digit + ' dabayein';
  });
  return 'Symbiote Systems. ' + parts.join(', ') + '.';
}

/**
 * Resolve one DTMF digit to an agent id, or null when the digit has no
 * mapping (the caller hears "invalid choice" and the menu repeats).
 */
function resolveDigit(config, digit) {
  var d = String(digit == null ? '' : digit).trim();
  if (!config || !Array.isArray(config.menu)) return null;
  for (var i = 0; i < config.menu.length; i++) {
    if (config.menu[i].digit === d) return config.menu[i].agentId;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Per-key JSON store: ivr_<keyHash>.json under DATA_DIR.
 * ------------------------------------------------------------------------- */

function IvrStore(dataDir, keyHash) {
  var kh = keystoreMod.normalizeKeyHash(keyHash); // throws on garbage
  this.dataDir = dataDir;
  this.keyHash = kh;
  this.file = path.join(dataDir, 'ivr_' + kh + '.json');
}

IvrStore.fileNameFor = function (keyHash) {
  return 'ivr_' + keystoreMod.normalizeKeyHash(keyHash) + '.json';
};

IvrStore.prototype._ensureDir = function () {
  if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
};

IvrStore.prototype.get = function () {
  this._ensureDir();
  if (!fs.existsSync(this.file)) return null;
  var raw;
  try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
  catch (e) { throw new Error('ivr config corrupt: ' + e.message); }
  return normalizeConfig(raw);
};

/** Save a raw config (validated + normalized first). Returns the normalized config. */
IvrStore.prototype.save = function (raw, agentExists) {
  this._ensureDir();
  var norm = normalizeConfig(raw, agentExists);
  var payload = JSON.stringify(norm, null, 2) + '\n';
  JSON.parse(payload);
  var tmp = this.file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, this.file);
  return norm;
};

module.exports = {
  normalizeConfig: normalizeConfig,
  buildMenuPrompt: buildMenuPrompt,
  resolveDigit: resolveDigit,
  IvrStore: IvrStore,
  MENU_TIMEOUT_MS: MENU_TIMEOUT_MS
};
