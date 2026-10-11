'use strict';
/**
 * src/bridge.js — one browser WebSocket = one phone call to one agent.
 *
 * Browser -> server:
 *   setup { apiKey?, agentId? | number?, model? }
 *   audio_in { data }   base64 PCM16 16kHz mono
 *   text { text }        chat message during the call
 *   keypad { digit }     DTMF pressed (tone plays locally; digit shown)
 *   diag_req {}
 *   hangup {}
 *
 * Server -> browser: live.js events, plus:
 *   { type:'call', agent:{...}, state:'connecting' }
 *   setup_complete includes the agent (call is "connected", timer starts)
 *   { type:'call_ended_by', by:'agent', name } — agent hung up itself
 *   { type:'error', message, code? }
 *
 * Memories (notes + transcript) and call history are scoped to the API key
 * in use (by hash). A different key wipes both — one key's data never leaks
 * into another's.
 */

var crypto = require('crypto');
var live = require('./live');
var agents = require('./agents');
var prompt = require('./prompt');

var DEFAULT_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-3.8-live-extended-thinking'];
var END_CALL_DELAY_MS = 4000; // let the spoken goodbye finish before closing

function keyHashOf(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }

function Bridge(ws, deps) {
  this.ws = ws;
  this.history = deps.history;
  this.memory = deps.memory;
  this.createSession = deps.createSession || live.createOmniSession;
  this.sdk = deps.sdk;
  this.envKey = deps.envKey || null;
  this.endCallDelayMs = deps.endCallDelayMs || END_CALL_DELAY_MS;
  this.session = null;
  this.agent = null;
  this.keyHash = null;
  this.callId = null;
  this.memId = null;
  this.memFinalized = false;
  this.connected = false;
  this.alive = true;
  var self = this;
  ws.on('message', function (raw) { self.onMessage(raw); });
  ws.on('close', function () { self.shutdown(); });
  ws.on('error', function () { self.shutdown(); });
}

Bridge.prototype.send = function (obj) {
  if (!this.alive) return;
  try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
};

Bridge.prototype.onMessage = function (raw) {
  var msg;
  try { msg = JSON.parse(String(raw)); } catch (e) { this.send({ type: 'error', message: 'bad JSON' }); return; }
  if (!msg || typeof msg.type !== 'string') { this.send({ type: 'error', message: 'bad message' }); return; }
  try {
    switch (msg.type) {
      case 'setup': this.handleSetup(msg); break;
      case 'audio_in':
        if (this.session && typeof msg.data === 'string') this.session.sendAudio(msg.data);
        break;
      case 'text':
        if (this.session && typeof msg.text === 'string' && msg.text.trim()) {
          if (!this.session.sendText(msg.text)) this.send({ type: 'error', message: 'call not connected yet' });
        }
        break;
      case 'keypad':
        this.send({ type: 'dtmf', digit: String(msg.digit || '').slice(0, 1) });
        break;
      case 'diag_req':
        if (this.session) this.send(Object.assign({ type: 'diag' }, this.session.getDiag()));
        break;
      case 'hangup': this.shutdown(); break;
      default: this.send({ type: 'error', message: 'unknown message type' });
    }
  } catch (e) {
    this.send({ type: 'error', message: 'handler error' });
  }
};

Bridge.prototype.resolveAgent = function (msg) {
  if (msg.agentId && typeof msg.agentId === 'string') return agents.getById(msg.agentId);
  if (msg.number && typeof msg.number === 'string') return agents.getByNumber(msg.number);
  return null;
};

Bridge.prototype.buildRecallText = function (agent, keyHash) {
  if (!this.memory) return null;
  var mems;
  try { mems = this.memory.recall(agent.id, keyHash, 3); } catch (e) { return null; }
  if (!mems.length) return null;
  var lines = mems.map(function (m) {
    var d = m.startedAt ? m.startedAt.slice(0, 10) : '';
    var notes = m.notes.length ? m.notes.join(' | ') : 'no notes recorded';
    return '- ' + d + ': ' + notes.slice(0, 300);
  });
  return 'Previous calls with this caller (most recent first):\n' + lines.join('\n');
};

Bridge.prototype.handleSetup = async function (msg) {
  var self = this;
  if (this.session) { this.send({ type: 'error', message: 'call already active' }); return; }
  var agent = this.resolveAgent(msg);
  if (!agent) {
    this.send({ type: 'error', message: 'number not in service', code: 'NO_SUCH_NUMBER' });
    return;
  }
  var key = (msg.apiKey && String(msg.apiKey).trim()) || this.envKey;
  if (!key) {
    this.send({ type: 'error', message: 'no API key: add it in Settings first', fatal: true, code: 'NO_KEY' });
    return;
  }
  this.agent = agent;
  this.keyHash = keyHashOf(key);

  // Key-scoped data: a different key wipes memories + history.
  try {
    if (this.memory) {
      var scope = await this.memory.ensureScope(this.keyHash);
      if (scope.reset && this.history) { await this.history.clear(); }
    }
  } catch (e) { /* non-fatal: continue without memory */ }

  var models = Array.isArray(msg.models) && msg.models.length ? msg.models.filter(function (m) { return typeof m === 'string'; }) : DEFAULT_MODELS.slice();
  if (msg.model && typeof msg.model === 'string' && msg.model.trim()) models = [msg.model.trim()].concat(models.filter(function (m) { return m !== msg.model.trim(); }));

  this.send({ type: 'call', state: 'connecting', agent: publicAgent(agent) });
  var recallText = this.buildRecallText(agent, this.keyHash);
  var session = this.createSession({
    sdk: this.sdk,
    store: null,
    apiKey: key,
    models: models,
    role: agent.niche,
    voice: agent.voice,
    agentId: agent.id,
    agentName: agent.name,
    systemInstruction: prompt.buildAgentInstruction(agent, recallText),
    onEvent: function (ev) { self.onEvent(ev); }
  });
  this.session = session;
  session.start();
};

Bridge.prototype.onEvent = function (ev) {
  var self = this;
  if (ev.type === 'setup_complete' && !this.connected) {
    this.connected = true;
    var info = { agentId: this.agent.id, agentName: this.agent.name, number: this.agent.number };
    var self2 = this;
    this._logStartP = this.history.logStart(info).then(function (id) { self2.callId = id; return id; }).catch(function () { return null; });
    if (this.memory) {
      this._memP = this.memory.beginCall(Object.assign({ keyHash: this.keyHash }, info))
        .then(function (id) { self2.memId = id; return id; }).catch(function () { return null; });
    }
    ev.agent = publicAgent(this.agent);
  }
  if (ev.type === 'transcript' && this._memP) {
    var memP = this._memP, memory = this.memory;
    this._memP.then(function (id) { if (id && memory) return memory.appendTranscript(id, ev.who, ev.text); }).catch(function () {});
  }
  if (ev.type === 'note_saved' && this._memP) {
    var memP2 = this._memP, memory2 = this.memory;
    this._memP.then(function (id) { if (id && memory2) return memory2.addNote(id, ev.note); }).catch(function () {});
  }
  if (ev.type === 'end_call_requested') {
    // The agent said goodbye and hung up itself. Tell the phone UI,
    // finalize the memory, then close after a short grace delay.
    this.send({ type: 'call_ended_by', by: 'agent', name: this.agent ? this.agent.name : '' });
    this.finalizeMemory();
    var s = this;
    setTimeout(function () { s.shutdown(); }, this.endCallDelayMs);
    return; // don't forward the raw tool event to the UI
  }
  this.send(ev);
};

function publicAgent(a) {
  return { id: a.id, name: a.name, niche: a.niche, number: a.number, voice: a.voice, color: a.color, tagline: a.tagline };
}

Bridge.prototype.finalizeMemory = function () {
  if (this.memFinalized) return;
  this.memFinalized = true;
  var memory = this.memory;
  if (this._memP && memory) {
    this._memP.then(function (id) { if (id) return memory.endCall(id); }).catch(function () {});
  }
};

Bridge.prototype.shutdown = function () {
  if (!this.alive) return;
  this.alive = false;
  var self = this;
  if (this.connected && this._logStartP) {
    this._logStartP.then(function (id) { if (id) return self.history.logEnd(id); }).catch(function () {});
  }
  this.finalizeMemory();
  try { if (this.session) this.session.hangup(); } catch (e) {}
  this.session = null;
  try { this.ws.close(); } catch (e) {}
};

module.exports = { Bridge: Bridge, DEFAULT_MODELS: DEFAULT_MODELS, publicAgent: publicAgent, keyHashOf: keyHashOf };
