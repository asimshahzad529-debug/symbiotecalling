'use strict';
/**
 * src/apiv7_custom.js — v7 custom-agent REST API (WS2).
 *
 * =====================================================================
 * CONTRACT FOR INTEGRATOR — read this before wiring:
 * ---------------------------------------------------------------------
 * 1) server.js wiring (require + mount):
 *      var apiv7custom = require('./src/apiv7_custom');
 *      var customAgents = require('./src/customAgents');
 *      var customStore = new customAgents.CustomAgentStore(DATA_DIR);
 *      var handleCustomV7 = apiv7custom.mount(null, {
 *        sendJson: sendJson,       // (res, code, obj)
 *        readBody: readBody,       // (req) -> Promise<string>
 *        dataDir: DATA_DIR,        // persistent dir (DATA_DIR env)
 *        agents: require('./src/agents'),  // built-ins (clone sources)
 *        customAgents: customAgents,       // the store module
 *        keyHashOf: bridge.keyHashOf       // sha256 hex of the API key
 *      });
 *    At the TOP of handleApi(req, res), before the existing if-chain:
 *      if (await handleCustomV7(req, res)) return;
 *    (mount returns an async handler that returns true when it handled the
 *    request, false otherwise — safe to place first because it only reacts
 *    to paths starting with '/api/v7/custom-agents'.)
 *
 * 2) bridge.js — resolve custom agents at call setup:
 *    In Bridge.prototype.resolveAgent (currently: getById / getByNumber),
 *    when msg.agentId starts with 'custom_', resolve via the store with
 *    the setup's keyHash (the Bridge already holds this.keyHash):
 *      if (msg.agentId && msg.agentId.indexOf('custom_') === 0) {
 *        var rec = customStore.get(this.keyHash, msg.agentId); // may throw on bad hash
 *        return rec ? customAgents.toAgent(rec) : null;
 *      }
 *    The returned object is shaped like a built-in agent, so everything
 *    downstream (publicAgent, buildAgentInstruction, Live session) works
 *    unchanged. bridge.js needs access to the same CustomAgentStore
 *    instance created in server.js (pass it through Bridge options).
 *
 * 3) prompt.js — SymAgent's directory:
 *    In buildAgentInstruction, where callingAgentsDirectory() is appended
 *    for id === 'symagent', also append:
 *      customAgents.directorySection(customStore.list(keyHash))
 *    The keyHash is available in bridge at call time (this.keyHash); pass
 *    the rendered string (or the custom list) into buildAgentInstruction
 *    via a new optional param so prompt.js stays pure.
 *
 * 4) live.js — transfer target resolution:
 *    In resolveTransferTarget(args), AFTER the built-in lookup
 *    (agents.getById / agents.getByNumber) fails, add:
 *      var custom = customAgents.findTarget(customStore, keyHash, id || number);
 *      if (custom) return { ok: true, target: { id, name, number, niche: custom.role } };
 *    keyHash comes from the live session's caller context (the setup that
 *    carried the keyHash). Keep the existing self-transfer guard
 *    (target.id === 'symagent') and keep the chain SymAgent-only —
 *    toolNamesFor() must NOT add transfer_call for any other agent,
 *    including custom ones.
 *
 * 5) client merge — merge custom agents into directory/dialer/history/
 *    stats rendering. Merge function signature:
 *      mergeAgentLists(builtinList, customList)
 *        -> builtinList.concat(customList) mapped through the same
 *           card/dialer row renderer; custom rows get a "Custom" badge
 *           and the default avatar.
 *    /api/v7/custom-agents is keyed by the x-key-hash header, same as the
 *    rest of the v7 key-gated API (window.KeyGate.apiFetch).
 * =====================================================================
 *
 * Routes (all JSON, keyHash via `x-key-hash` header or `?keyHash=`):
 *   GET    /api/v7/custom-agents              -> { agents: [publicCustomAgent...] }
 *   POST   /api/v7/custom-agents              -> { agent } | 400 { error }
 *   GET    /api/v7/custom-agents/:id          -> { agent } | 404
 *   PUT    /api/v7/custom-agents/:id          -> { agent } | 400/404 { error }
 *   DELETE /api/v7/custom-agents/:id          -> { ok: true } | 404
 *   POST   /api/v7/custom-agents/clone        -> { draft } | 400/404 { error }
 *
 * v7.5: avatar/profile-picture upload was removed. All custom agents use
 * the default phone-caller avatar. The old `GET /:id/avatar` route and the
 * DATA_DIR/avatars_custom file storage are gone.
 */

var url = require('url');

function mount(api, ctx) {
  ctx = ctx || {};
  var sendJson = ctx.sendJson;
  var readBody = ctx.readBody;
  var dataDir = ctx.dataDir;
  var agentsMod = ctx.agents;
  var customAgents = ctx.customAgents;
  if (typeof sendJson !== 'function') throw new Error('ctx.sendJson required');
  if (typeof readBody !== 'function') throw new Error('ctx.readBody required');
  if (!dataDir) throw new Error('ctx.dataDir required');
  if (!agentsMod) throw new Error('ctx.agents required');
  if (!customAgents) throw new Error('ctx.customAgents required');

  var store = new customAgents.CustomAgentStore(dataDir);

  function keyHashOfReq(req) {
    var h = (req.headers && (req.headers['x-key-hash'] || req.headers['x-keyhash'])) || '';
    if (!h) {
      var q = url.parse(req.url || '', true).query;
      h = q.keyHash || '';
    }
    return customAgents.isKeyHash(h) ? String(h) : null;
  }

  async function parseJsonBody(req) {
    var body = await readBody(req);
    try { return JSON.parse(body || '{}'); }
    catch (e) { var err = new Error('invalid JSON body'); err.code = 'BAD_JSON'; throw err; }
  }

  async function handle(req, res) {
    var parsed = url.parse(req.url || '', true);
    var pathname = parsed.pathname || '';
    if (pathname.indexOf('/api/v7/custom-agents') !== 0) return false;
    var method = req.method || 'GET';

    // Clone endpoint must match before the :id route.
    if (method === 'POST' && pathname === '/api/v7/custom-agents/clone') {
      var keyHash = keyHashOfReq(req);
      if (!keyHash) return sendJson(res, 400, { error: 'missing or invalid x-key-hash header (or ?keyHash=)' });
      var body;
      try { body = await parseJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      var sourceId = body && body.sourceId ? String(body.sourceId) : '';
      if (!sourceId) return sendJson(res, 400, { error: 'sourceId is required' });
      var source = null;
      if (sourceId.indexOf('custom_') === 0) {
        // Clone protection: custom agents are never cloneable, by anyone.
        return sendJson(res, 403, { error: 'custom agents cannot be cloned' });
      } else {
        source = agentsMod.getById(sourceId);
      }
      if (!source) return sendJson(res, 404, { error: 'source agent not found' });
      try {
        var draft = customAgents.cloneFrom(keyHash, source);
        return sendJson(res, 200, { draft: draft });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    var idMatch = /^\/api\/v7\/custom-agents\/([^/]+)$/.exec(pathname);
    var isRoot = pathname === '/api/v7/custom-agents';

    if (!isRoot && !idMatch) return false;

    var kh = keyHashOfReq(req);
    if (!kh) return sendJson(res, 400, { error: 'missing or invalid x-key-hash header (or ?keyHash=)' });

    if (method === 'GET' && isRoot) {
      var list;
      try { list = store.list(kh); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      return sendJson(res, 200, { agents: list.map(customAgents.publicCustomAgent) });
    }

    if (method === 'GET' && idMatch) {
      var got;
      try { got = store.get(kh, decodeURIComponent(idMatch[1])); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (!got) return sendJson(res, 404, { error: 'custom agent not found' });
      return sendJson(res, 200, { agent: customAgents.publicCustomAgent(got) });
    }

    if (method === 'POST' && isRoot) {
      var createBody;
      try { createBody = await parseJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      try {
        var created = await store.create(kh, createBody);
        return sendJson(res, 201, { agent: customAgents.publicCustomAgent(created) });
      } catch (e) {
        return sendJson(res, e.code === 'VALIDATION' ? 400 : 500, { error: e.message });
      }
    }

    if (method === 'PUT' && idMatch) {
      var uid = decodeURIComponent(idMatch[1]);
      var updateBody;
      try { updateBody = await parseJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      try {
        var updated = await store.update(kh, uid, updateBody);
        return sendJson(res, 200, { agent: customAgents.publicCustomAgent(updated) });
      } catch (e) {
        return sendJson(res, e.code === 'VALIDATION' ? 400 : e.code === 'NOT_FOUND' ? 404 : 500, { error: e.message });
      }
    }

    if (method === 'DELETE' && idMatch) {
      var did = decodeURIComponent(idMatch[1]);
      try {
        await store.remove(kh, did);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, e.code === 'NOT_FOUND' ? 404 : 500, { error: e.message });
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return handle;
}

module.exports = { mount: mount };
