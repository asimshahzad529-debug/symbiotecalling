'use strict';
/* tests/integration-v7.test.js — WS7 integrator tests: the wiring between
 * the six workstream modules and the existing server/bridge/live/prompt.
 * Zero-dependency, no network, no real API key. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');
var http = require('http');

var bridgeMod = require('../src/bridge');
var live = require('../src/live');
var prompt = require('../src/prompt');
var storeMod = require('../src/store');
var memoryMod = require('../src/memory');
var keystoreMod = require('../src/keystore');
var customAgents = require('../src/customAgents');

function tmpdir(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx)); }

/* --- fake WebSocket + SDK (same style as protocol.test.js) --- */
function MockWs() { this.handlers = {}; this.sent = []; this.closed = false; }
MockWs.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };
MockWs.prototype.send = function (data) { this.sent.push(JSON.parse(data)); };
MockWs.prototype.close = function () { this.closed = true; };
MockWs.prototype.emitMsg = function (obj) { this.handlers.message(JSON.stringify(obj)); };

function fakeSdk() {
  var connects = [], sessions = [];
  function FakeGenAI() {}
  FakeGenAI.prototype.live = {
    connect: async function (params) {
      connects.push(params);
      var sess = {
        callbacks: params.callbacks,
        sendClientContent: function () {},
        sendRealtimeInput: function () {},
        sendToolResponse: function () {},
        close: function () {}
      };
      sessions.push(sess);
      return sess;
    }
  };
  return {
    Modality: { AUDIO: 'AUDIO' }, Type: { OBJECT: 'OBJECT', STRING: 'STRING', BOOLEAN: 'BOOLEAN' },
    GoogleGenAI: FakeGenAI, _connects: connects, _sessions: sessions
  };
}

function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 4); i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}

function newTestBridge(dir, sdk, extra) {
  var ws = new MockWs();
  var deps = Object.assign({
    history: new storeMod.CallHistory(dir),
    memory: new memoryMod.MemoryStore(dir),
    sdk: sdk, envKey: null,
    createSession: live.createOmniSession,
    keystore: new keystoreMod.KeyStore(dir, { maxConcurrent: 1 }),
    customStore: new customAgents.CustomAgentStore(dir),
    dataDir: dir
  }, extra || {});
  new bridgeMod.Bridge(ws, deps);
  return ws;
}

module.exports = {
  'bridge: custom_ agentId resolves through the per-key custom store': async function () {
    var dir = tmpdir('ws7-int-');
    var sdk = fakeSdk();
    var kh = bridgeMod.keyHashOf('INT-KEY');
    var store = new customAgents.CustomAgentStore(dir);
    var rec = await store.create(kh, { name: 'Int Tester', number: '0300999888', role: 'Integration Specialist', tone: 'friendly', voice: 'Charon', prompt: 'Be helpful.' });
    var ws = newTestBridge(dir, sdk);
    ws.emitMsg({ type: 'setup', apiKey: 'INT-KEY', agentId: rec.id });
    await tick(8);
    var callMsg = ws.sent.filter(function (m) { return m.type === 'call'; })[0];
    assert.ok(callMsg, 'connecting message sent');
    assert.strictEqual(callMsg.agent.id, rec.id, 'custom agent resolved');
    assert.strictEqual(callMsg.agent.name, 'Int Tester');
    assert.strictEqual(sdk._connects.length, 1, 'live session created for custom agent');
    assert.ok(sdk._connects[0].config.systemInstruction.indexOf('Int Tester') !== -1, 'instruction built for custom agent');
    // custom agents must NOT get transfer_call
    assert.ok(live.toolNamesFor(rec.id).indexOf('transfer_call') === -1, 'no transfer_call for custom agents');
  },

  'bridge: unknown custom_ id -> number not in service': async function () {
    var dir = tmpdir('ws7-int-');
    var sdk = fakeSdk();
    var ws = newTestBridge(dir, sdk);
    ws.emitMsg({ type: 'setup', apiKey: 'INT-KEY', agentId: 'custom_deadbeef' });
    await tick(4);
    var err = ws.sent.filter(function (m) { return m.type === 'error'; })[0];
    assert.ok(err && err.code === 'NO_SUCH_NUMBER', 'unknown custom id rejected');
  },

  'bridge: rate limiting — second concurrent call gets RATE_LIMITED, slot freed on close': async function () {
    var dir = tmpdir('ws7-int-');
    var sdk = fakeSdk();
    var ks = new keystoreMod.KeyStore(dir, { maxConcurrent: 1 });
    var mk = function () {
      var ws = new MockWs();
      new bridgeMod.Bridge(ws, {
        history: new storeMod.CallHistory(dir), memory: new memoryMod.MemoryStore(dir),
        sdk: sdk, envKey: null, createSession: live.createOmniSession,
        keystore: ks, customStore: new customAgents.CustomAgentStore(dir), dataDir: dir
      });
      return ws;
    };
    var ws1 = mk();
    ws1.emitMsg({ type: 'setup', apiKey: 'RL-KEY', agentId: 'ava' });
    await tick(4);
    var ws2 = mk();
    ws2.emitMsg({ type: 'setup', apiKey: 'RL-KEY', agentId: 'ava' });
    await tick(4);
    var err = ws2.sent.filter(function (m) { return m.type === 'error'; })[0];
    assert.ok(err && err.code === 'RATE_LIMITED', 'second concurrent call rate-limited, got: ' + JSON.stringify(err));
    assert.ok(ws2.closed, 'rate-limited socket closed');
    assert.strictEqual(ks.activeCalls(bridgeMod.keyHashOf('RL-KEY')), 1, 'one slot held');
    // closing the first call releases the slot
    ws1.handlers.close();
    await tick(2);
    assert.strictEqual(ks.activeCalls(bridgeMod.keyHashOf('RL-KEY')), 0, 'slot released on close');
    var ws3 = mk();
    ws3.emitMsg({ type: 'setup', apiKey: 'RL-KEY', agentId: 'ava' });
    await tick(4);
    var err3 = ws3.sent.filter(function (m) { return m.type === 'error'; })[0];
    assert.ok(!err3, 'call after release is not rate-limited');
  },

  'bridge: per-key partitions — history/memory files scoped by keyHash': async function () {
    var dir = tmpdir('ws7-int-');
    var sdk = fakeSdk();
    var ws = newTestBridge(dir, sdk);
    ws.emitMsg({ type: 'setup', apiKey: 'PART-KEY', agentId: 'ava' });
    await tick(6);
    sdk._sessions[0].callbacks.onmessage({ setupComplete: {} });
    await tick(6);
    var kh = bridgeMod.keyHashOf('PART-KEY');
    assert.ok(fs.existsSync(path.join(dir, 'calls_' + kh + '.json')), 'per-key history file created');
    assert.ok(fs.existsSync(path.join(dir, 'memories_' + kh + '.json')), 'per-key memory file created');
    assert.ok(!fs.existsSync(path.join(dir, 'calls.json')), 'legacy shared file not created by keyed bridge');
  },

  'bridge: usage metering + audit recorded on call end': async function () {
    var dir = tmpdir('ws7-int-');
    var sdk = fakeSdk();
    var ks = new keystoreMod.KeyStore(dir);
    var ws = new MockWs();
    new bridgeMod.Bridge(ws, {
      history: new storeMod.CallHistory(dir), memory: new memoryMod.MemoryStore(dir),
      sdk: sdk, envKey: null, createSession: live.createOmniSession,
      keystore: ks, customStore: new customAgents.CustomAgentStore(dir), dataDir: dir
    });
    ws.emitMsg({ type: 'setup', apiKey: 'USE-KEY', agentId: 'ava' });
    await tick(6);
    sdk._sessions[0].callbacks.onmessage({ setupComplete: {} });
    await tick(6);
    ws.handlers.close();
    await tick(6);
    var kh = bridgeMod.keyHashOf('USE-KEY');
    var usage = ks.getUsage(kh);
    assert.ok(usage && usage.calls >= 1, 'call recorded in usage, got: ' + JSON.stringify(usage));
    var entries = ks.auditList(50).filter(function (e) { return e && e.keyHash === kh; });
    var events = entries.map(function (e) { return e.event; });
    assert.ok(events.indexOf('call_start') !== -1, 'call_start audited');
    assert.ok(events.indexOf('call_end') !== -1, 'call_end audited');
  },

  'prompt: symagent instruction appends custom-agent directory section': function () {
    var agent = { id: 'symagent', name: 'SymAgent', gender: null, niche: 'rep', number: '1', voice: 'Kore', prompt: 'x', knowledge: 'COMPANY' };
    var section = customAgents.directorySection([{ name: 'Mine', role: 'Tester', number: '0300111222', id: 'custom_x' }]);
    var instr = prompt.buildAgentInstruction(agent, null, section);
    assert.ok(instr.indexOf('CUSTOM AGENTS') !== -1, 'custom section appended');
    assert.ok(instr.indexOf('Mine') !== -1, 'custom agent named');
    var instr2 = prompt.buildAgentInstruction(agent, null, '');
    assert.ok(instr2.indexOf('CUSTOM AGENTS') === -1, 'empty section omitted');
    var other = { id: 'lina', name: 'Elena', gender: 'female', niche: 'Travel Concierge', number: '2', voice: 'Kore', prompt: 'y', knowledge: null };
    assert.ok(prompt.buildAgentInstruction(other, null, section).indexOf('CUSTOM AGENTS') === -1, 'non-symagent gets no directory');
  },

  'live: createOmniSession without systemInstruction falls back cleanly': function () {
    var sess = live.createOmniSession({
      sdk: { GoogleGenAI: function () {}, Modality: { AUDIO: 'A' }, Type: {} },
      apiKey: 'X', role: 'tester', voice: 'Kore', agentId: 'lina', agentName: 'Elena'
    });
    assert.ok(sess && typeof sess.start === 'function', 'session created with fallback instruction');
    sess.hangup();
  },

  'live: executeTool transfer_call resolves custom agents via ctx': async function () {
    var dir = tmpdir('ws7-int-');
    var store = new customAgents.CustomAgentStore(dir);
    var kh = 'b'.repeat(64);
    var rec = await store.create(kh, { name: 'Xfer Target', number: '0300555666', role: 'Xfer Role', tone: 'professional', voice: 'Charon', prompt: 'x' });
    var seen = [];
    var r = await live.executeTool('transfer_call', { agentId: rec.id }, {
      emit: function (e) { seen.push(e); }, customStore: store, keyHash: kh
    });
    assert.ok(r.ok, 'transfer ok: ' + JSON.stringify(r));
    assert.strictEqual(r.transfer.id, rec.id);
    assert.strictEqual(r.transfer.niche, 'Xfer Role');
    assert.ok(seen.some(function (e) { return e.type === 'transfer_requested'; }), 'transfer_requested emitted');
    var bad = await live.executeTool('transfer_call', { agentId: 'custom_nope' }, {
      emit: function () {}, customStore: store, keyHash: kh
    });
    assert.ok(!bad.ok, 'unknown custom id fails');
  }
};

/* --- live server mount smoke test (spawns server.js) --- */
var PORT = 18741;
var serverJs = path.join(__dirname, '..', 'server.js');

function req(method, p, body, headers) {
  return new Promise(function (resolve, reject) {
    var data = body === undefined ? null : JSON.stringify(body);
    var rq = http.request({ port: PORT, path: p, method: method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) },
      function (res) {
        var chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          var json = null;
          try { json = JSON.parse(text); } catch (e) {}
          resolve({ status: res.statusCode, json: json });
        });
      });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

module.exports['server: v7 mounts respond (keygate 401/400, custom-agents 400, notes 404)'] = async function () {
  var dataDir = tmpdir('ws7-int-srv-');
  var child = childProcess.spawn(process.execPath, [serverJs], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    // wait for readiness
    var t0 = Date.now();
    for (;;) {
      try {
        var h = await req('GET', '/api/health');
        if (h.status === 200) break;
      } catch (e) {}
      if (Date.now() - t0 > 10000) throw new Error('server did not start');
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    var usage = await req('GET', '/api/v7/key/usage');
    assert.ok(usage.status === 401 || usage.status === 400, 'usage without key -> 401/400, got ' + usage.status);
    var profiles = await req('GET', '/api/v7/key/profiles');
    assert.strictEqual(profiles.status, 200, 'profiles list 200');
    assert.ok(Array.isArray(profiles.json.profiles), 'profiles envelope');
    var customs = await req('GET', '/api/v7/custom-agents');
    assert.strictEqual(customs.status, 400, 'custom-agents without key -> 400, got ' + customs.status);
    var notes = await req('POST', '/api/v7/calls/call_nope/notes', { notes: 'hello' });
    assert.strictEqual(notes.status, 404, 'notes for unknown call -> 404, got ' + notes.status);
  } finally {
    try { child.kill(); } catch (e) {}
  }
};
