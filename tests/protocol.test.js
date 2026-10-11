'use strict';
/* tests/protocol.test.js — dial-by-number / agentId protocol with a fake SDK.
 * No network, no API key.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var storeMod = require('../src/store');
var memoryMod = require('../src/memory');
var live = require('../src/live');
var bridgeMod = require('../src/bridge');

function tick(n) {
  return new Promise(function (res) {
    var i = 0;
    (function next() { if (++i >= (n || 4)) res(); else setImmediate(next); })();
  });
}

function MockWs() {
  this.sent = []; this.handlers = {}; this.readyState = 1; this.closed = false;
}
MockWs.prototype.on = function (ev, cb) { this.handlers[ev] = cb; };
MockWs.prototype.send = function (data) { this.sent.push(JSON.parse(data)); };
MockWs.prototype.close = function () { this.closed = true; };
MockWs.prototype.emitMsg = function (obj) { this.handlers.message(JSON.stringify(obj)); };

function fakeSdk() {
  var connects = [], sessions = [];
  function FakeGenAI(opts) { this.apiKey = opts.apiKey; }
  FakeGenAI.prototype.live = {
    connect: async function (params) {
      connects.push(params);
      var sess = {
        callbacks: params.callbacks, realtimeInputs: [], clientContents: [], toolResponses: [], closed: false,
        sendRealtimeInput: function (p) { this.realtimeInputs.push(p); },
        sendClientContent: function (p) { this.clientContents.push(p); },
        sendToolResponse: function (p) { this.toolResponses.push(p); },
        close: function () { this.closed = true; }
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

function tmpHistory() { return new storeMod.CallHistory(fs.mkdtempSync(path.join(os.tmpdir(), 'call-proto-'))); }

function tmpMemory() { return new memoryMod.MemoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-proto-'))); }

function newBridge(sdk, history, setupMsg) {
  return newBridgeFull(sdk, history, null, setupMsg);
}

function newBridgeFull(sdk, history, memory, setupMsg, extraDeps) {
  var ws = new MockWs();
  new bridgeMod.Bridge(ws, Object.assign(
    { history: history, memory: memory, sdk: sdk, envKey: null, createSession: live.createOmniSession },
    extraDeps || {}
  ));
  ws.emitMsg(setupMsg);
  return ws;
}

module.exports = {
  'dial by number resolves the right agent with its voice + instruction': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = newBridge(sdk, history, { type: 'setup', apiKey: 'DUMMY', number: '+1 (555) 010-0004' });
    await tick();
    assert.strictEqual(sdk._connects.length, 1);
    var cfg = sdk._connects[0].config;
    assert.strictEqual(cfg.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Enceladus');
    assert.ok(cfg.systemInstruction.indexOf('Lucas') !== -1, 'agent instruction used');
    assert.ok(cfg.systemInstruction.indexOf('NEVER diagnose') !== -1, 'safety prompt included');
    assert.strictEqual(ws.sent[0].type, 'call');
    assert.strictEqual(ws.sent[0].state, 'connecting');
    assert.strictEqual(ws.sent[0].agent.name, 'Lucas');
  },
  'call by agentId works too': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    newBridge(sdk, history, { type: 'setup', apiKey: 'DUMMY', agentId: 'nova' });
    await tick();
    assert.strictEqual(sdk._connects[0].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    assert.ok(sdk._connects[0].config.systemInstruction.indexOf('Mia') !== -1);
  },
  'unknown number -> number not in service, no session': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = newBridge(sdk, history, { type: 'setup', apiKey: 'DUMMY', number: '+1 (555) 999-9999' });
    await tick();
    assert.strictEqual(sdk._connects.length, 0);
    assert.ok(ws.sent.some(function (m) { return m.type === 'error' && m.code === 'NO_SUCH_NUMBER'; }));
  },
  'no key -> NO_KEY error': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = newBridge(sdk, history, { type: 'setup', agentId: 'ava' });
    await tick();
    assert.strictEqual(sdk._connects.length, 0);
    assert.ok(ws.sent.some(function (m) { return m.type === 'error' && m.code === 'NO_KEY'; }));
  },
  'one setup_complete -> call logged; hangup -> duration logged, session closed': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = newBridge(sdk, history, { type: 'setup', apiKey: 'DUMMY', agentId: 'ava' });
    await tick();
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    sess.callbacks.onmessage({ setupComplete: {} }); // duplicate ignored
    await tick(6);
    var setups = ws.sent.filter(function (m) { return m.type === 'setup_complete'; });
    assert.strictEqual(setups.length, 1);
    assert.strictEqual(setups[0].agent.name, 'Jacob', 'phone UI gets agent info');
    assert.strictEqual(sess.clientContents.length, 1, 'exactly one greeting');
    assert.ok(sess.clientContents[0].turns[0].parts[0].text.indexOf('Jacob') !== -1);
    ws.emitMsg({ type: 'hangup' });
    await tick(6);
    assert.strictEqual(sess.closed, true);
    var calls = history.list();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].agentId, 'ava');
    assert.ok(calls[0].endedAt, 'call end logged');
    assert.strictEqual(typeof calls[0].durationSec, 'number');
  },
  'chat text during call uses turnComplete:true; transcripts forwarded': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = newBridge(sdk, history, { type: 'setup', apiKey: 'DUMMY', agentId: 'kai' });
    await tick();
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    await tick();
    var before = sess.clientContents.length;
    ws.emitMsg({ type: 'text', text: 'salam' });
    assert.strictEqual(sess.clientContents.length, before + 1);
    assert.strictEqual(sess.clientContents[before].turnComplete, true);
    sess.callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Walaikum salam!' } } });
    await tick();
    assert.ok(ws.sent.some(function (m) { return m.type === 'transcript' && m.text === 'Walaikum salam!'; }));
  },
  'keypad digit is echoed back, never sent to the model': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = newBridge(sdk, history, { type: 'setup', apiKey: 'DUMMY', agentId: 'mia' });
    await tick();
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    await tick();
    var before = sess.clientContents.length;
    ws.emitMsg({ type: 'keypad', digit: '5' });
    assert.strictEqual(sess.clientContents.length, before, 'DTMF must not become a model turn');
    assert.ok(ws.sent.some(function (m) { return m.type === 'dtmf' && m.digit === '5'; }));
  },
  'greeting watchdog: silent model gets one nudge': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = new MockWs();
    new bridgeMod.Bridge(ws, {
      history: history, sdk: sdk, envKey: null,
      createSession: function (opts) { opts.greetingNudgeMs = 60; return live.createOmniSession(opts); }
    });
    ws.emitMsg({ type: 'setup', apiKey: 'DUMMY', agentId: 'ava' });
    await tick();
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    await tick();
    assert.strictEqual(sess.clientContents.length, 1, 'greeting trigger sent');
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.strictEqual(sess.clientContents.length, 2, 'one nudge after silence');
    assert.ok(sess.clientContents[1].turns[0].parts[0].text.indexOf('greeting') !== -1);
  },
  'greeting watchdog: model output cancels the nudge': async function () {
    var sdk = fakeSdk(), history = tmpHistory();
    var ws = new MockWs();
    new bridgeMod.Bridge(ws, {
      history: history, sdk: sdk, envKey: null,
      createSession: function (opts) { opts.greetingNudgeMs = 60; return live.createOmniSession(opts); }
    });
    ws.emitMsg({ type: 'setup', apiKey: 'DUMMY', agentId: 'ava' });
    await tick();
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    await tick();
    // model speaks promptly
    sess.callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] } } });
    await new Promise(function (r) { setTimeout(r, 200); });
    assert.strictEqual(sess.clientContents.length, 1, 'no nudge when model responded');
  },
  'save_note tool -> note_saved -> memory entry has the note': async function () {
    var sdk = fakeSdk(), history = tmpHistory(), memory = tmpMemory();
    var ws = newBridgeFull(sdk, history, memory, { type: 'setup', apiKey: 'KEY-A', agentId: 'harper' });
    await tick(6);
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    await tick(6);
    sess.callbacks.onmessage({ toolCall: { functionCalls: [{ id: 't1', name: 'save_note', args: { note: 'Root canal on Oct 20, 10am' } }] } });
    await tick(8);
    assert.ok(ws.sent.some(function (m) { return m.type === 'note_saved'; }), 'note_saved forwarded');
    assert.strictEqual(sess.toolResponses.length, 1);
    var mems = memory.list(memory.keyHash('KEY-A'));
    assert.strictEqual(mems.length, 1);
    assert.ok(mems[0].notes.some(function (n) { return n.text.indexOf('Oct 20') !== -1; }), 'note persisted');
    ws.emitMsg({ type: 'hangup' });
    await tick(6);
  },
  'end_call tool -> agent hangs up itself, memory finalized': async function () {
    var sdk = fakeSdk(), history = tmpHistory(), memory = tmpMemory();
    var ws = newBridgeFull(sdk, history, memory, { type: 'setup', apiKey: 'KEY-A', agentId: 'ava' }, { endCallDelayMs: 80 });
    await tick(6);
    var sess = sdk._sessions[0];
    sess.callbacks.onmessage({ setupComplete: {} });
    await tick(6);
    sess.callbacks.onmessage({ toolCall: { functionCalls: [{ id: 't2', name: 'end_call', args: {} }] } });
    await tick(6);
    assert.ok(ws.sent.some(function (m) { return m.type === 'call_ended_by' && m.by === 'agent'; }), 'UI told the agent ended the call');
    assert.ok(!ws.sent.some(function (m) { return m.type === 'end_call_requested'; }), 'raw tool event not leaked to UI');
    await new Promise(function (r) { setTimeout(r, 250); });
    assert.strictEqual(sess.closed, true, 'session closed after grace delay');
    assert.strictEqual(ws.closed, true, 'socket closed');
    var mems = memory.list(memory.keyHash('KEY-A'));
    assert.strictEqual(mems.length, 1);
    assert.ok(mems[0].endedAt, 'memory finalized');
  },
  'recall: past notes are injected into the next call instruction': async function () {
    var sdk = fakeSdk(), history = tmpHistory(), memory = tmpMemory();
    var kh = memory.keyHash('KEY-A');
    var id = await memory.beginCall({ keyHash: kh, agentId: 'mia', agentName: 'Mia', number: 'x' });
    await memory.addNote(id, 'Haircut booked for Friday 5pm');
    await memory.endCall(id);
    var ws = newBridgeFull(sdk, history, memory, { type: 'setup', apiKey: 'KEY-A', agentId: 'mia' });
    await tick(6);
    var instr = sdk._connects[0].config.systemInstruction;
    assert.ok(instr.indexOf('Friday 5pm') !== -1, 'agent remembers the booking');
    assert.ok(instr.indexOf('Previous calls') !== -1);
    ws.emitMsg({ type: 'hangup' });
    await tick(4);
  },
  'key change wipes memories and history': async function () {
    var sdk = fakeSdk(), history = tmpHistory(), memory = tmpMemory();
    var ws1 = newBridgeFull(sdk, history, memory, { type: 'setup', apiKey: 'KEY-A', agentId: 'ava' });
    await tick(6);
    sdk._sessions[0].callbacks.onmessage({ setupComplete: {} });
    await tick(6);
    ws1.emitMsg({ type: 'hangup' });
    await tick(8);
    assert.strictEqual(memory.list().length, 1);
    assert.strictEqual(history.list().length, 1);
    var ws2 = newBridgeFull(sdk, history, memory, { type: 'setup', apiKey: 'KEY-B', agentId: 'ava' });
    await tick(8);
    assert.strictEqual(memory.list().length, 0, 'memories wiped on key change');
    assert.strictEqual(history.list().length, 0, 'history wiped on key change');
    assert.strictEqual(sdk._connects.length, 2, 'new key still connects fine');
    ws2.emitMsg({ type: 'hangup' });
    await tick(4);
  }
};
