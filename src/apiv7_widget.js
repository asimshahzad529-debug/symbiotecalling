'use strict';
/**
 * src/apiv7_widget.js -- v8 #3 website embed widget (server side).
 *
 * =====================================================================
 * CONTRACT FOR INTEGRATOR (coordinator) -- read this before wiring:
 * ---------------------------------------------------------------------
 * 1) server.js wiring (require + mount), next to the other apiv7 mounts:
 *      var apiv7widget = require('./src/apiv7_widget');
 *      var handleWidgetV8 = apiv7widget.mount(null, {
 *        sendJson: sendJson,   // (res, code, obj)
 *        dataDir: DATA_DIR,    // persistent dir (DATA_DIR env)
 *        keystore: keystore    // KeyStore instance (for public ref lookup)
 *      });
 *    At the TOP of handleApi(req, res), before the existing if-chain
 *    (alongside handleCustomV7):
 *      if (await handleWidgetV8(req, res)) return;
 *    (mount returns an async handler that returns true when it handled the
 *    request, false otherwise -- safe to place first because it only reacts
 *    to paths starting with '/api/v8/widget-config'.)
 *
 * 2) Companion client snippet: public/widget.js (drop-in <script> for
 *    client websites). It reads data-app / data-ref from its own <script>
 *    tag, fetches this endpoint, renders the floating "Call us" button,
 *    and opens /widget-call.html?key=<publicRef>&line=<businessNumber>
 *    in a popup. The actual /widget-call.html page is built by the
 *    frontend worker (out of scope for this module).
 *
 * 3) Optional per-key line/name overrides (used by v8 #26 virtual
 *    business lines): saveWidgetConfig(dataDir, keyHash, { businessName,
 *    businessNumber }). Falls back to the key profile label / ''.
 * =====================================================================
 *
 * Routes:
 *   GET /api/v8/widget-config?ref=<publicRef>
 *     -> 200 { businessNumber, businessName }
 *     -> 400 { error } (missing/malformed ref)
 *     -> 404 { error } (unknown ref)
 *
 * The public ref is derived from the keyHash (NOT the raw key):
 *   'sym_' + sha256('symbiote-widget-v1:' + keyHash).slice(0, 16)
 * Opaque to clients; resolvable server-side via the keystore profiles.
 * No raw keys, no keyHashes, no key material in the response.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var REF_RE = /^[A-Za-z0-9_-]{4,64}$/;
var WIDGET_FILE = 'widgets.json';
var MAX_NAME_LEN = 80;
var MAX_NUMBER_LEN = 40;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * Public, embeddable reference for a keyHash. Deterministic so the same
 * key always maps to the same ref; unusable to recover the keyHash
 * (one-way hash) and unrelated to the raw API key.
 */
function publicRefFor(keyHash) {
  return 'sym_' + sha256('symbiote-widget-v1:' + keyHash).slice(0, 16);
}

function widgetFile(dataDir) { return path.join(dataDir, WIDGET_FILE); }

function readWidgetDoc(dataDir) {
  try {
    var f = widgetFile(dataDir);
    if (!fs.existsSync(f)) return {};
    var v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}

/** Optional per-key override { businessName, businessNumber }. */
function getWidgetConfig(dataDir, keyHash) {
  var doc = readWidgetDoc(dataDir);
  var c = doc[keyHash];
  if (!c || typeof c !== 'object') return null;
  return {
    businessName: typeof c.businessName === 'string' ? c.businessName.slice(0, MAX_NAME_LEN) : '',
    businessNumber: typeof c.businessNumber === 'string' ? c.businessNumber.slice(0, MAX_NUMBER_LEN) : ''
  };
}

/**
 * Persist a per-key widget override (used by the v8 #26 business-line
 * worker). Not exposed as a route here -- another worker owns that API.
 */
function saveWidgetConfig(dataDir, keyHash, cfg) {
  cfg = cfg || {};
  var doc = readWidgetDoc(dataDir);
  doc[keyHash] = {
    businessName: String(cfg.businessName || '').slice(0, MAX_NAME_LEN),
    businessNumber: String(cfg.businessNumber || '').slice(0, MAX_NUMBER_LEN),
    updatedAt: new Date().toISOString()
  };
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  var f = widgetFile(dataDir);
  var tmp = f + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, f);
  return doc[keyHash];
}

/** Resolve a public ref back to a keyHash via the keystore profiles. */
function resolveKeyHash(keystore, ref) {
  if (!keystore || typeof keystore.listProfiles !== 'function') return null;
  var profiles;
  try { profiles = keystore.listProfiles(); } catch (e) { return null; }
  if (!Array.isArray(profiles)) return null;
  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    if (p && typeof p.keyHash === 'string' && publicRefFor(p.keyHash) === ref) {
      return { keyHash: p.keyHash, label: p.label || '' };
    }
  }
  return null;
}

function mount(_ignored, deps) {
  deps = deps || {};
  var sendJson = deps.sendJson;
  var dataDir = deps.dataDir;
  var keystore = deps.keystore || null;

  return async function handleWidgetV8(req, res) {
    var url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return false; }
    if (url.pathname !== '/api/v8/widget-config') return false;
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    var ref = url.searchParams.get('ref');
    if (!ref || !REF_RE.test(ref)) {
      sendJson(res, 400, { error: 'ref required' });
      return true;
    }
    var hit = resolveKeyHash(keystore, ref);
    if (!hit) {
      sendJson(res, 404, { error: 'unknown ref' });
      return true;
    }
    var override = getWidgetConfig(dataDir, hit.keyHash);
    var businessName = (override && override.businessName) || hit.label || 'Symbiote Calling';
    var businessNumber = (override && override.businessNumber) || '';
    sendJson(res, 200, { businessNumber: businessNumber, businessName: businessName });
    return true;
  };
}

module.exports = {
  mount: mount,
  publicRefFor: publicRefFor,
  getWidgetConfig: getWidgetConfig,
  saveWidgetConfig: saveWidgetConfig,
  resolveKeyHash: resolveKeyHash,
  REF_RE: REF_RE
};
