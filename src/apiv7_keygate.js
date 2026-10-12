'use strict';
/**
 * src/apiv7_keygate.js — v7 key-gating REST API (WS1).
 *
 * Routes (all JSON; the client identifies itself with the `x-key-hash`
 * header or `?keyHash=` — the raw API key NEVER travels to the server):
 *   GET    /api/v7/key/profiles            -> { profiles: [{keyHash,label,createdAt}] }
 *   POST   /api/v7/key/profiles            -> { ok: true } | 400 { error }
 *   DELETE /api/v7/key/profiles/:keyHash   -> { ok: true } | 400 { error }
 *   GET    /api/v7/key/usage                -> { calls, minutes } (caller's key) | 401/400
 *   GET    /api/v7/audit                    -> { entries: [...] } (recent, owner view) | 401/400
 *
 * keyHash format (sha256 hex) is validated on every input; garbage gets 400.
 *
 * =====================================================================
 * CONTRACT FOR INTEGRATOR — read this before wiring:
 * ---------------------------------------------------------------------
 * 1) server.js wiring (require + mount), right after the other requires:
 *
 *      var keystoreMod = require('./src/keystore');
 *      var keygateMod = require('./src/apiv7_keygate');
 *      var keystore = new keystoreMod.KeyStore(DATA_DIR);   // optional: { maxConcurrent: 3 }
 *      var keygateApi = keygateMod.createApi();
 *      keygateMod.mount(keygateApi, {
 *        sendJson: sendJson,        // (res, code, obj)
 *        readBody: readBody,        // (req) -> Promise<string>
 *        dataDir: DATA_DIR,         // persistent dir (DATA_DIR env)
 *        keystore: keystore,        // the KeyStore above (omit -> one is created)
 *        keyHashOf: bridge.keyHashOf// sha256 hex of the raw API key
 *      });
 *
 *    Then at the TOP of the http request handler, BEFORE the
 *    `req.url.startsWith('/api/')` method split (the v7 routes include a
 *    POST, and server.js currently sends POSTs to handlePost):
 *
 *      if (req.url.startsWith('/api/v7/key/') || req.url.startsWith('/api/v7/audit')) {
 *        return keygateApi.handle(req, res);
 *      }
 *
 *    mount() registers routes on the given api object via
 *    api.route(method, path, handler); handler receives (req, res, params)
 *    where params holds any :name segments and `query` (a URLSearchParams).
 *    keygateApi.handle(req, res) dispatches to the matching route or 404s.
 *    (If api is null, mount() creates one internally and returns a
 *    dispatch function instead: `var handleKeyGate = keygateMod.mount(null, ctx);`.)
 *
 * 2) bridge.js — rate limiting + usage metering patch points (in /live setup):
 *
 *    In Bridge.prototype.handleSetup, AFTER this.keyHash is computed and
 *    BEFORE the session is created:
 *
 *      if (keystore && !keystore.tryAcquire(this.keyHash)) {
 *        this.send({ type: 'error', message: 'too many concurrent calls for this key', code: 'RATE_LIMITED' });
 *        try { this.ws.close(); } catch (e) {}
 *        return;
 *      }
 *
 *    On socket close (Bridge.prototype.shutdown), ALWAYS release the slot:
 *
 *      if (keystore && this.keyHash) keystore.release(this.keyHash);
 *
 *    On call end (in shutdown, when the call actually connected, or in
 *    finalizeMemory), record usage — durationSec is known after logEnd:
 *
 *      // minutes = (durationSec || 0) / 60
 *      if (keystore && this.keyHash) keystore.recordCall(this.keyHash, minutes).catch(function(){});
 *
 *    Also add an audit entry on setup: keystore.audit({ keyHash, label, event:'call_start', agentId }).
 *    The label can be looked up from keystore.listProfiles(). The Bridge
 *    needs the same KeyStore instance created in server.js — pass it
 *    through the Bridge options (deps.keystore), same as history/memory.
 *
 *    REPLACE the old wipe-on-key-change path with per-key instances:
 *      var history = new storeMod.CallHistory(DATA_DIR, this.keyHash);
 *      var memory  = new memoryMod.MemoryStore(DATA_DIR, this.keyHash);
 *    and DELETE the ensureScope/clear() wipe block. With per-key files the
 *    wipe is obsolete — switching keys can never destroy data.
 *
 * 3) public/app.js — boot order (KeyGate must run before any render/fetch):
 *
 *      // very first thing in the app boot (before loadAgents/renderAgents):
 *      await KeyGate.init();            // shows the login overlay when no key is stored
 *      var apiKey = KeyGate.getKey();   // raw key for the /live WebSocket setup message
 *
 *    Then replace every direct fetch() to /api/* with KeyGate.apiFetch(),
 *    which attaches the `x-key-hash` header automatically. The raw key is
 *    sent ONLY inside the WebSocket `setup` message (same as today) — never
 *    in a URL or a REST header.
 *
 *    Wire the profile switcher into the Settings view:
 *      KeyGate.openSwitcher(document.body);  // modal: list labels, switch key, delete profile
 *    e.g. behind a "Switch key / manage keys" button in Settings.
 *
 * 4) public/index.html — script/link tags (order matters, BEFORE app.js):
 *
 *      <link rel="stylesheet" href="keygate.css">
 *      ...
 *      <script src="keygate.js"></script>
 *      <script src="app.js"></script>
 *
 *    keygate.css must load after styles.css so the overlay rules win;
 *    keygate.js must load before app.js so window.KeyGate exists at boot.
 * =====================================================================
 */

var keystoreMod = require('./keystore');

/** Normalize a candidate keyHash from any source; throws on garbage. */
function cleanKeyHash(h) {
  return keystoreMod.normalizeKeyHash(h);
}

/**
 * The keyHash identifying the caller: `x-key-hash` header first, then
 * `?keyHash=` query param. Returns the normalized hash, or null.
 */
function callerKeyHash(req) {
  var h = null;
  if (req.headers && typeof req.headers['x-key-hash'] === 'string') h = req.headers['x-key-hash'];
  if (!h && req.url) {
    try { h = new URL(req.url, 'http://localhost').searchParams.get('keyHash'); } catch (e) { /* ignore */ }
  }
  if (!h) return null;
  try { return cleanKeyHash(h.trim()); } catch (e) { return 'INVALID'; }
}

/**
 * Minimal router: api.route(method, path, handler) registers exact-path
 * routes; path segments may contain :name params. handler(req, res, params)
 * with params.query = URLSearchParams. handle(req, res) dispatches.
 */
function createApi() {
  var routes = [];
  function matchPattern(pattern, pathname) {
    var pp = pattern.split('/'), sp = pathname.split('/');
    if (pp.length !== sp.length) return null;
    var params = {};
    for (var i = 0; i < pp.length; i++) {
      if (pp[i].charAt(0) === ':') params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
      else if (pp[i] !== sp[i]) return null;
    }
    return params;
  }
  return {
    route: function (method, path, handler) {
      routes.push({ method: String(method).toUpperCase(), path: path, handler: handler });
      return this;
    },
    handle: function (req, res) {
      var pathname, query;
      try {
        var u = new URL(req.url, 'http://localhost');
        pathname = u.pathname; query = u.searchParams;
      } catch (e) { return null; }
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        if (r.method !== String(req.method).toUpperCase()) continue;
        var params = matchPattern(r.path, pathname);
        if (!params) continue;
        params.query = query;
        try { r.handler(req, res, params); } catch (e) {
          if (res && !res.headersSent && this._sendJson) this._sendJson(res, 500, { error: 'server error' });
        }
        return true;
      }
      return false;
    },
    _routes: routes
  };
}

function mount(api, ctx) {
  ctx = ctx || {};
  var sendJson = ctx.sendJson;
  var readBody = ctx.readBody;
  var keystore = ctx.keystore || new keystoreMod.KeyStore(ctx.dataDir || '.');
  var keyHashOf = ctx.keyHashOf || function (k) {
    return require('crypto').createHash('sha256').update(String(k)).digest('hex');
  };

  var router = api || createApi();
  // give the router a way to 500 on handler throw
  router._sendJson = sendJson;

  function needCallerKey(req, res) {
    var kh = callerKeyHash(req);
    if (kh === null) { sendJson(res, 401, { error: 'login required: no key' }); return null; }
    if (kh === 'INVALID') { sendJson(res, 400, { error: 'keyHash must be 64 hex chars' }); return null; }
    return kh;
  }

  router.route('GET', '/api/v7/key/profiles', function (req, res) {
    try { sendJson(res, 200, { profiles: keystore.listProfiles() }); }
    catch (e) { sendJson(res, 500, { error: 'read failed' }); }
  });

  router.route('POST', '/api/v7/key/profiles', function (req, res) {
    readBody(req).then(function (raw) {
      var body;
      try { body = JSON.parse(raw); } catch (e) { sendJson(res, 400, { error: 'bad JSON' }); return; }
      var kh;
      try { kh = cleanKeyHash(body && body.keyHash); }
      catch (e) { sendJson(res, 400, { error: 'keyHash must be 64 hex chars' }); return; }
      var label = body && body.label != null ? String(body.label) : '';
      keystore.addProfile(kh, label).then(function (profile) {
        keystore.audit({ keyHash: kh, label: profile.label, event: 'profile_add', agentId: null }).catch(function () {});
        sendJson(res, 200, { ok: true, profile: profile });
      }).catch(function () { sendJson(res, 500, { error: 'save failed' }); });
    }).catch(function () { sendJson(res, 400, { error: 'bad request' }); });
  });

  router.route('DELETE', '/api/v7/key/profiles/:keyHash', function (req, res, params) {
    var kh;
    try { kh = cleanKeyHash(params.keyHash); }
    catch (e) { sendJson(res, 400, { error: 'keyHash must be 64 hex chars' }); return; }
    keystore.removeProfile(kh).then(function () {
      keystore.audit({ keyHash: kh, label: '', event: 'profile_remove', agentId: null }).catch(function () {});
      sendJson(res, 200, { ok: true });
    }).catch(function () { sendJson(res, 500, { error: 'delete failed' }); });
  });

  router.route('GET', '/api/v7/key/usage', function (req, res) {
    var kh = needCallerKey(req, res);
    if (!kh) return;
    try { sendJson(res, 200, keystore.getUsage(kh)); }
    catch (e) { sendJson(res, 500, { error: 'read failed' }); }
  });

  router.route('GET', '/api/v7/audit', function (req, res) {
    var kh = needCallerKey(req, res);
    if (!kh) return;
    try {
      // v7.5 per-key isolation: the audit log is one device-local file, so
      // entries are filtered to the caller's own key — one key must never
      // see another key's call/login events. Read the full cap first so a
      // busy sibling key can't push this key's entries out of the window.
      var all = keystore.auditList(keystoreMod.MAX_AUDIT_ENTRIES);
      var mine = all.filter(function (e) { return e && e.keyHash === kh; });
      sendJson(res, 200, { entries: mine.slice(0, 100) });
    }
    catch (e) { sendJson(res, 500, { error: 'read failed' }); }
  });

  if (!api) {
    // Sibling-workstream style: return a dispatch handler instead.
    return function (req, res) { return router.handle(req, res); };
  }
  return router;
}

module.exports = { mount: mount, createApi: createApi, callerKeyHash: callerKeyHash };
