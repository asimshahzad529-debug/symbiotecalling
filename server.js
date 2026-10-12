'use strict';
/**
 * server.js — Symbiote Calling.
 *
 * One localhost server: static frontend + WebSocket call bridge (/live) +
 * local APIs.  npm install && npm run dev  ->  http://localhost:3000
 *
 * The Gemini API key lives in server memory for its call only — never
 * logged, never written to disk, never in a URL. Call history is local
 * metadata only (agent, number, time, duration).
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var WebSocket = require('ws');

var bridge = require('./src/bridge');
var agents = require('./src/agents');
var storeMod = require('./src/store');
var memoryMod = require('./src/memory');
var statsMod = require('./src/stats');
/* v7 workstream APIs (WS7 integrator wiring). */
var keystoreMod = require('./src/keystore');
var keygateMod = require('./src/apiv7_keygate');
var apiv7custom = require('./src/apiv7_custom');
var customAgents = require('./src/customAgents');
var callxApi = require('./src/apiv7_callx');
var cleanupMod = require('./src/cleanup');

(function loadEnv() {
  var p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  fs.readFileSync(p, 'utf8').split('\n').forEach(function (line) {
    var m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
})();

var PORT = parseInt(process.env.PORT || '3000', 10);
// Locally we bind loopback only; on hosting platforms (Render etc. sets PORT)
// we must bind all interfaces or the platform router cannot reach us.
var HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
var PUBLIC = path.join(__dirname, 'public');
// Data dir is configurable so hosting volumes survive redeploys:
// e.g. DATA_DIR=/data with a Railway volume mounted at /data.
var DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Data retention (v7 auto-cleanup): recordings/transcripts/call records
// older than this many days are pruned at startup and daily. Client-side
// setting in Settings only governs the device's IndexedDB recordings.
var RETENTION_DAYS = cleanupMod.retentionDays(process.env.RETENTION_DAYS);
var history = new storeMod.CallHistory(DATA_DIR);
var memory = new memoryMod.MemoryStore(DATA_DIR);

/* v7 key gating: one KeyStore for rate limits, usage metering, audit, and
 * key profiles. The raw key never reaches the server — REST clients send
 * only its sha256 hash (x-key-hash header). */
var keystore = new keystoreMod.KeyStore(DATA_DIR, { maxConcurrent: 3 });
var keygateApi = keygateMod.createApi();
keygateMod.mount(keygateApi, {
  sendJson: sendJson,        // (res, code, obj)
  readBody: readBody,        // (req) -> Promise<string>
  dataDir: DATA_DIR,
  keystore: keystore,
  keyHashOf: bridge.keyHashOf
});

/* v7 custom agents: per-key store + REST API. */
var customStore = new customAgents.CustomAgentStore(DATA_DIR);
var handleCustomV7 = apiv7custom.mount(null, {
  sendJson: sendJson,
  readBody: readBody,
  dataDir: DATA_DIR,
  agents: agents,
  customAgents: customAgents,
  keyHashOf: bridge.keyHashOf
});

/* Key-aware store instances for REST routes: when the caller identifies
 * with a valid x-key-hash (or ?keyHash=), routes read/write that key's
 * partition; otherwise they fall back to the legacy shared instance. */
function callerKeyHash(req) {
  var h = keygateMod.callerKeyHash(req);
  return (h && h !== 'INVALID') ? h : null;
}
function reqHistory(req) {
  var kh = callerKeyHash(req);
  return kh ? new storeMod.CallHistory(DATA_DIR, kh) : history;
}
function reqMemory(req) {
  var kh = callerKeyHash(req);
  return kh ? new memoryMod.MemoryStore(DATA_DIR, kh) : memory;
}

var MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); try { req.destroy(); } catch (e) {} return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var p = url.pathname;
  // v7 custom-agent API (keyed by x-key-hash). Handled first; returns
  // false for any non-/api/v7/custom-agents path.
  if (await handleCustomV7(req, res)) return;
  // Key-scoped stores for this caller (falls back to the legacy shared
  // instance when no key hash is presented).
  var khHistory = reqHistory(req);
  var khMemory = reqMemory(req);
  if (p === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, product: 'symbiote-calling', agents: agents.list().length, time: new Date().toISOString() });
  }
  if (p === '/api/agents' && req.method === 'GET') {
    return sendJson(res, 200, { agents: agents.list() });
  }
  if (p === '/api/history' && req.method === 'GET') {
    try { return sendJson(res, 200, { calls: khHistory.list() }); }
    catch (e) { return sendJson(res, 500, { error: 'read failed' }); }
  }
  if (p === '/api/history' && req.method === 'DELETE') {
    khHistory.clear().then(function () { sendJson(res, 200, { cleared: true }); })
      .catch(function () { sendJson(res, 500, { error: 'clear failed' }); });
    return;
  }
  if (p === '/api/memories' && req.method === 'GET') {
    try { return sendJson(res, 200, { memories: khMemory.list() }); }
    catch (e) { return sendJson(res, 500, { error: 'read failed' }); }
  }
  if (p === '/api/stats' && req.method === 'GET') {
    try { return sendJson(res, 200, { stats: statsMod.computeStats(khHistory.list(), khMemory.list()) }); }
    catch (e) { return sendJson(res, 500, { error: 'stats failed' }); }
  }
  if (p === '/api/memories' && req.method === 'DELETE') {
    khMemory.clear().then(function () { sendJson(res, 200, { cleared: true }); })
      .catch(function () { sendJson(res, 500, { error: 'clear failed' }); });
    return;
  }
  var memMatch = p.match(/^\/api\/memories\/([A-Za-z0-9_]+)$/);
  if (memMatch && req.method === 'GET') {
    try {
      var m = khMemory.get(memMatch[1]);
      return m ? sendJson(res, 200, { memory: m }) : sendJson(res, 404, { error: 'not found' });
    } catch (e) { return sendJson(res, 500, { error: 'read failed' }); }
  }
  if (memMatch && req.method === 'DELETE') {
    khMemory.remove(memMatch[1]).then(function () { sendJson(res, 200, { deleted: true }); })
      .catch(function () { sendJson(res, 500, { error: 'delete failed' }); });
    return;
  }
  return sendJson(res, 404, { error: 'not found' });
}

/* POST routes that need a JSON body. */
async function handlePost(req, res) {
  // v7 custom-agent API: POST /api/v7/custom-agents and /clone land here
  // (server.js routes all POSTs to handlePost). handleCustomV7 reads the
  // body itself, so it must run BEFORE readBody is consumed below.
  try {
    if (await handleCustomV7(req, res)) return;
  } catch (e) {
    try { sendJson(res, 500, { error: 'server error' }); } catch (e2) {}
    return;
  }
  var url = new URL(req.url, 'http://localhost');
  var p = url.pathname;
  try {
    var body = JSON.parse(await readBody(req));
    if (p === '/api/restore') {
      var mems = body.memories, calls = body.history;
      if ((mems === undefined && calls === undefined) ||
          (mems !== undefined && !Array.isArray(mems)) ||
          (calls !== undefined && !Array.isArray(calls))) {
        return sendJson(res, 400, { error: 'body must contain memories[] and/or history[] arrays' });
      }
      var out = { memories: 0, history: 0 };
      var khMemory = reqMemory(req), khHistory = reqHistory(req);
      if (Array.isArray(mems)) out.memories = await khMemory.importAll(mems);
      if (Array.isArray(calls)) out.history = await khHistory.importAll(calls);
      return sendJson(res, 200, { restored: out });
    }
    var sumMatch = p.match(/^\/api\/history\/([A-Za-z0-9_]+)\/summary$/);
    if (sumMatch) {
      var summary = body && typeof body.summary === 'string' ? body.summary.trim() : '';
      if (!summary) return sendJson(res, 400, { error: 'summary required' });
      var khHistory = reqHistory(req), khMemory = reqMemory(req);
      var call = khHistory.list().find(function (c) { return c.id === sumMatch[1]; });
      if (!call) return sendJson(res, 404, { error: 'call not found' });
      await khHistory.setSummary(call.id, summary);
      // Mirror into the matching memory entry so the Memory page shows it too.
      try {
        var mem = khMemory.list().find(function (m) {
          return m.agentId === call.agentId &&
            Math.abs(Date.parse(m.startedAt) - Date.parse(call.startedAt)) < 120000;
        });
        if (mem) await khMemory.setSummary(mem.id, summary);
      } catch (e) { /* non-fatal */ }
      return sendJson(res, 200, { saved: true });
    }
    // v7 in-call notes (CallX). Mounted in handlePost before the final 404,
    // with the CALLER's key-scoped history so notes land in calls_<keyHash>.json.
    var notesMatch = callxApi.NOTES_ROUTE.exec(p);
    if (notesMatch) {
      var noteKeyHash = callerKeyHash(req);
      if (!noteKeyHash && body && typeof body.keyHash === 'string' && /^[0-9a-f]{64}$/.test(body.keyHash)) {
        noteKeyHash = body.keyHash;
      }
      var notesHistory = noteKeyHash ? new storeMod.CallHistory(DATA_DIR, noteKeyHash) : history;
      return callxApi.handleNotes(notesMatch[1], body, { history: notesHistory, memory: reqMemory(req) })
        .then(function (r) { sendJson(res, r.status, r.body); })
        .catch(function () { sendJson(res, 500, { error: 'server error' }); });
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 400, { error: 'bad request' });
  }
}

function serveStatic(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var rel = url.pathname === '/' ? '/index.html' : url.pathname;
  var file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  // Avatar fallback: when avatars were deployed via text-only tooling they are stored
  // as base64 sidecars (<name>.jpg.b64); decode and serve them as real JPEGs.
  if (rel.startsWith('/avatars/') && /\.jpg$/i.test(rel) && !fs.existsSync(file)) {
    var b64file = file + '.b64';
    if (fs.existsSync(b64file)) {
      try {
        var img = Buffer.from(fs.readFileSync(b64file, 'utf8').replace(/\s+/g, ''), 'base64');
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': img.length });
        res.end(img);
        return;
      } catch (e) { /* fall through to 404 */ }
    }
  }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

var server = http.createServer(function (req, res) {
  // v7 key-gating routes (they include POSTs, so they must run before the
  // /api/ method split below, which would route POSTs to handlePost).
  if (req.url.startsWith('/api/v7/key/') || req.url.startsWith('/api/v7/audit')) {
    return keygateApi.handle(req, res);
  }
  if (req.url.startsWith('/api/')) {
    if (req.method === 'POST') { handlePost(req, res); return; }
    handleApi(req, res).catch(function () {
      try { sendJson(res, 500, { error: 'server error' }); } catch (e) {}
    });
    return;
  }
  serveStatic(req, res);
});

var wss = new WebSocket.Server({ server: server, path: '/live' });
var sdk = null;
try { sdk = require('@google/genai'); } catch (e) { console.error('[calling] @google/genai not installed — run npm install'); }

wss.on('connection', function (ws) {
  new bridge.Bridge(ws, {
    history: history, memory: memory, sdk: sdk,
    envKey: process.env.GEMINI_API_KEY || null,
    keystore: keystore,        // v7 rate limiting + usage metering + audit
    customStore: customStore,  // v7 custom-agent resolution
    dataDir: DATA_DIR          // v7 per-key history/memory partitions
  });
});

/* v7 auto-cleanup: prune call records + memory transcripts older than
 * RETENTION_DAYS at startup and once a day. Key-partitioned files are all
 * scanned, so stale keys' data doesn't accumulate forever. */
function runPrune() {
  storeMod.CallHistory.pruneAll(DATA_DIR, RETENTION_DAYS)
    .then(function (r) {
      if (r.removed) console.log('[calling] cleanup: pruned ' + r.removed + ' call record(s) older than ' + RETENTION_DAYS + 'd');
    })
    .catch(function () {});
  memoryMod.MemoryStore.pruneAll(DATA_DIR, RETENTION_DAYS)
    .then(function (r) {
      if (r.removed) console.log('[calling] cleanup: pruned ' + r.removed + ' memor' + (r.removed === 1 ? 'y' : 'ies') + ' older than ' + RETENTION_DAYS + 'd');
    })
    .catch(function () {});
}
runPrune();
setInterval(runPrune, 24 * 60 * 60 * 1000);

server.listen(PORT, HOST, function () {
  console.log('[calling] Symbiote Calling v7.5 on http://' + HOST + ':' + PORT + ' — ' + agents.list().length + ' agents ready');
});
