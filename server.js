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
var history = new storeMod.CallHistory(path.join(__dirname, 'data'));
var memory = new memoryMod.MemoryStore(path.join(__dirname, 'data'));

var MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleApi(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var p = url.pathname;
  if (p === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, product: 'symbiote-calling', agents: agents.list().length, time: new Date().toISOString() });
  }
  if (p === '/api/agents' && req.method === 'GET') {
    return sendJson(res, 200, { agents: agents.list() });
  }
  if (p === '/api/history' && req.method === 'GET') {
    try { return sendJson(res, 200, { calls: history.list() }); }
    catch (e) { return sendJson(res, 500, { error: 'read failed' }); }
  }
  if (p === '/api/history' && req.method === 'DELETE') {
    history.clear().then(function () { sendJson(res, 200, { cleared: true }); })
      .catch(function () { sendJson(res, 500, { error: 'clear failed' }); });
    return;
  }
  if (p === '/api/memories' && req.method === 'GET') {
    try { return sendJson(res, 200, { memories: memory.list() }); }
    catch (e) { return sendJson(res, 500, { error: 'read failed' }); }
  }
  if (p === '/api/memories' && req.method === 'DELETE') {
    memory.clear().then(function () { sendJson(res, 200, { cleared: true }); })
      .catch(function () { sendJson(res, 500, { error: 'clear failed' }); });
    return;
  }
  var memMatch = p.match(/^\/api\/memories\/([A-Za-z0-9_]+)$/);
  if (memMatch && req.method === 'GET') {
    try {
      var m = memory.get(memMatch[1]);
      return m ? sendJson(res, 200, { memory: m }) : sendJson(res, 404, { error: 'not found' });
    } catch (e) { return sendJson(res, 500, { error: 'read failed' }); }
  }
  if (memMatch && req.method === 'DELETE') {
    memory.remove(memMatch[1]).then(function () { sendJson(res, 200, { deleted: true }); })
      .catch(function () { sendJson(res, 500, { error: 'delete failed' }); });
    return;
  }
  return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var rel = url.pathname === '/' ? '/index.html' : url.pathname;
  var file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

var server = http.createServer(function (req, res) {
  if (req.url.startsWith('/api/')) { try { handleApi(req, res); } catch (e) { sendJson(res, 500, { error: 'server error' }); } return; }
  serveStatic(req, res);
});

var wss = new WebSocket.Server({ server: server, path: '/live' });
var sdk = null;
try { sdk = require('@google/genai'); } catch (e) { console.error('[calling] @google/genai not installed — run npm install'); }

wss.on('connection', function (ws) {
  new bridge.Bridge(ws, { history: history, memory: memory, sdk: sdk, envKey: process.env.GEMINI_API_KEY || null });
});

server.listen(PORT, HOST, function () {
  console.log('[calling] Symbiote Calling v5.0 on http://' + HOST + ':' + PORT + ' — ' + agents.list().length + ' agents ready');
});
