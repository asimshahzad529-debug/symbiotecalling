'use strict';
/* tests/server.test.js — v6.0 HTTP integration: /api/stats, /api/restore,
 * POST /api/history/:id/summary, and DATA_DIR wiring. Spawns the real
 * server.js as a child process on a test port with a temp DATA_DIR. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var childProcess = require('child_process');

var PORT = 18731;
var serverJs = path.join(__dirname, '..', 'server.js');

function startServer(dataDir) {
  var child = childProcess.spawn(process.execPath, [serverJs], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return child;
}

function waitReady(child) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function poll() {
      var req = http.get({ port: PORT, path: '/api/health' }, function (res) {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() - t0 > 8000) return reject(new Error('server did not start in time'));
        setTimeout(poll, 150);
      }
    })();
  });
}

function req(method, p, body) {
  return new Promise(function (resolve, reject) {
    var data = body === undefined ? null : JSON.stringify(body);
    var rq = http.request({ port: PORT, path: p, method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          var json = null;
          try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, json: json, text: text });
        });
      });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

var child = null;
var dataDir = null;

async function withServer(fn) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symv6-'));
  child = startServer(dataDir);
  try {
    await waitReady(child);
    await fn();
  } finally {
    try { child.kill(); } catch (e) {}
    child = null;
  }
}

module.exports = {
  'server respects DATA_DIR and serves /api/stats': async function () {
    await withServer(async function () {
      var r = await req('GET', '/api/stats');
      assert.strictEqual(r.status, 200, 'stats 200');
      // DATA_DIR wiring: files must land in the temp dir, not ./data.
      assert.ok(fs.existsSync(path.join(dataDir, 'calls.json')), 'calls.json created under DATA_DIR');
      assert.ok(r.json && r.json.stats, 'stats envelope');
      assert.strictEqual(r.json.stats.totalCalls, 0, 'no calls yet');
      assert.deepStrictEqual(r.json.stats.topAgents, [], 'no top agents');
      assert.strictEqual(r.json.stats.leadsCaptured, 0, 'no leads');
    });
  },

  'restore validates input and summary round-trips to call + memory': async function () {
    await withServer(async function () {
      var bad = await req('POST', '/api/restore', { memories: 'nope' });
      assert.strictEqual(bad.status, 400, 'non-array restore rejected');

      var seed = await req('POST', '/api/restore', {
        history: [{ id: 'call_seed1', agentId: 'lina', agentName: 'Elena', number: '+1 (555) 010-0003',
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSec: 90 }],
        memories: [{ id: 'mem_seed1', agentId: 'lina', agentName: 'Elena', number: '+1 (555) 010-0003',
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationSec: 90,
          notes: [], transcript: [] }]
      });
      assert.strictEqual(seed.status, 200, 'restore 200');
      assert.strictEqual(seed.json.restored.history, 1, 'one call restored');
      assert.strictEqual(seed.json.restored.memories, 1, 'one memory restored');

      var s = await req('GET', '/api/stats');
      assert.strictEqual(s.json.stats.totalCalls, 1, 'stats see restored call');
      assert.strictEqual(s.json.stats.totalMinutes, 2, '90s rounds to 2 min');
      assert.strictEqual(s.json.stats.topAgents.length, 1, 'one top agent');
      assert.strictEqual(s.json.stats.topAgents[0].agentId, 'lina', 'top agent is Elena');

      var miss = await req('POST', '/api/history/call_nope/summary', { summary: 'x' });
      assert.strictEqual(miss.status, 404, 'unknown call 404');
      var empty = await req('POST', '/api/history/call_seed1/summary', { summary: '  ' });
      assert.strictEqual(empty.status, 400, 'empty summary 400');

      var ok = await req('POST', '/api/history/call_seed1/summary', { summary: 'Caller asked about travel. Outcome: question answered.' });
      assert.strictEqual(ok.status, 200, 'summary saved');
      assert.strictEqual(ok.json.saved, true, 'saved flag');

      var h = await req('GET', '/api/history');
      var c = h.json.calls.find(function (x) { return x.id === 'call_seed1'; });
      assert.ok(c && /Outcome: question answered/.test(c.summary), 'summary on call record');

      var m = await req('GET', '/api/memories/mem_seed1');
      assert.ok(m.json.memory && /Outcome: question answered/.test(m.json.memory.summary), 'summary mirrored to memory');
    });
  },

  'server startup log carries v8.0': function () {
    var src = fs.readFileSync(serverJs, 'utf8');
    assert.ok(/Symbiote Calling v8\.0/.test(src), 'startup log says v8.0');
    assert.ok(/process\.env\.DATA_DIR/.test(src), 'DATA_DIR wired');
  }
};
