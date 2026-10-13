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
 * in use (by hash): per-key partitions under DATA_DIR. Switching keys
 * never wipes or leaks another key's data. Rate limiting, usage metering,
 * and an audit log are kept per key by src/keystore.js.
 */

var crypto = require('crypto');
var live = require('./live');
var agents = require('./agents');
var prompt = require('./prompt');
var storeMod = require('./store');
var memoryMod = require('./memory');
var customAgents = require('./customAgents');
var businessLine = require('./businessLine');
var ivrMod = require('./ivr');
var teamsMod = require('./teams');

var DEFAULT_MODELS = ['gemini-3.8-live', 'gemini-3.1-flash-live-preview', 'gemini-3.8-live-extended-thinking'];
var END_CALL_DELAY_MS = 4000; // let the spoken goodbye finish before closing
var TRANSFER_DELAY_MS = 2500; // grace for the spoken handoff before the transfer takes over

function keyHashOf(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }

function Bridge(ws, deps) {
  this.ws = ws;
  this.history = deps.history;
  this.memory = deps.memory;
  this.createSession = deps.createSession || live.createOmniSession;
  this.sdk = deps.sdk;
  this.envKey = deps.envKey || null;
  this.endCallDelayMs = deps.endCallDelayMs || END_CALL_DELAY_MS;
  this.keystore = deps.keystore || null;       // v7 rate limiting / usage / audit
  this.customStore = deps.customStore || null; // v7 custom-agent resolution
  this.dataDir = deps.dataDir || null;         // v7 per-key history/memory partitions
  this.session = null;
  this.agent = null;
  this.keyHash = null;
  this.callId = null;
  this.memId = null;
  this.memFinalized = false;
  this.connected = false;
  this.alive = true;
  this._connectAt = 0;
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
  // v7 custom agents: ids start with 'custom_', resolved from the caller's
  // per-key store so one key's agents never leak to another key.
  if (msg.agentId && typeof msg.agentId === 'string' && msg.agentId.indexOf('custom_') === 0) {
    if (!this.customStore) return null;
    var rec;
    try { rec = this.customStore.get(this.keyHash, msg.agentId); } catch (e) { return null; }
    return rec ? customAgents.toAgent(rec) : null;
  }
  if (msg.agentId && typeof msg.agentId === 'string') return agents.getById(msg.agentId);
  if (msg.number && typeof msg.number === 'string') {
    // v8 #26: business-line inbound — the key's own front-door number routes
    // to the receptionist agent; live.js runs the IVR menu phase for it.
    try {
      if (this.keyHash && businessLine.numberForKeyHash(this.keyHash) === msg.number) {
        this._businessInbound = { from: (msg.from && String(msg.from)) || 'widget' };
        var _team = new teamsMod.TeamStore(this.dataDir || '.', this.keyHash).get();
        var _recId = (_team && _team.receptionistAgentId) || teamsMod.DEFAULT_RECEPTIONIST;
        return agents.getById(_recId) || agents.getById('symagent');
      }
    } catch (e) { /* fall through to normal resolution */ }
    var builtin = agents.getByNumber(msg.number);
    if (builtin) return builtin;
    // v7.5: custom agents of the ACTIVE key are dialable by their number too.
    // Resolution stays inside the caller's per-key partition (this.keyHash),
    // so one key's custom numbers can never be reached from another key.
    if (this.customStore && this.keyHash) {
      try {
        var custom = customAgents.findTarget(this.customStore, this.keyHash, msg.number);
        if (custom) return custom;
      } catch (e) { /* fall through to not-in-service */ }
    }
    return null;
  }
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
  // The key must be known BEFORE resolving the agent: custom agents are
  // looked up in the caller's per-key store (v7 key gating).
  var key = (msg.apiKey && String(msg.apiKey).trim()) || this.envKey;
  if (!key) {
    this.send({ type: 'error', message: 'no API key: add it in Settings first', fatal: true, code: 'NO_KEY' });
    return;
  }
  this.keyHash = keyHashOf(key);
  var agent = this.resolveAgent(msg);
  if (!agent) {
    this.send({ type: 'error', message: 'number not in service', code: 'NO_SUCH_NUMBER' });
    return;
  }
  this.agent = agent;

  // v7 rate limiting: at most maxConcurrent live calls per key.
  if (this.keystore && !this.keystore.tryAcquire(this.keyHash)) {
    this.send({ type: 'error', message: 'too many concurrent calls for this key', code: 'RATE_LIMITED' });
    try { this.ws.close(); } catch (e) {}
    return;
  }
  // Audit the call start (best effort; label looked up from key profiles).
  if (this.keystore) {
    try {
      var label = '';
      var profs = this.keystore.listProfiles();
      for (var pi = 0; pi < profs.length; pi++) {
        if (profs[pi] && profs[pi].keyHash === this.keyHash) { label = profs[pi].label || ''; break; }
      }
      this.keystore.audit({ keyHash: this.keyHash, label: label, event: 'call_start', agentId: agent.id }).catch(function () {});
    } catch (e) { /* non-fatal */ }
  }

  // v7 per-key data: this key's own history + memory partition. The old
  // wipe-on-key-switch (ensureScope) is obsolete — switching keys can
  // never destroy another key's data.
  if (this.dataDir) {
    try {
      this.history = new storeMod.CallHistory(this.dataDir, this.keyHash);
      this.memory = new memoryMod.MemoryStore(this.dataDir, this.keyHash);
    } catch (e) { /* keep the shared instances on partition failure */ }
  }

  var models = Array.isArray(msg.models) && msg.models.length ? msg.models.filter(function (m) { return typeof m === 'string'; }) : DEFAULT_MODELS.slice();
  if (msg.model && typeof msg.model === 'string' && msg.model.trim()) models = [msg.model.trim()].concat(models.filter(function (m) { return m !== msg.model.trim(); }));

  this.send({ type: 'call', state: 'connecting', agent: publicAgent(agent) });
  var recallText = this.buildRecallText(agent, this.keyHash);
  // v7: SymAgent's prompt also lists the caller's custom agents.
  var customDir = '';
  if (agent.id === 'symagent' && this.customStore) {
    try { customDir = customAgents.directorySection(this.customStore.list(this.keyHash)); } catch (e) {}
  }
  // v8 #15: team config for the receptionist's smart-routing instructions
  // (only SymAgent gets the team block — transfer_call is SymAgent-only).
  var teamCfg = null;
  if (agent.id === 'symagent') {
    try { teamCfg = new teamsMod.TeamStore(this.dataDir || '.', this.keyHash).get(); } catch (e) {}
  }
  // v8 #26/#13: business-line inbound carries the IVR config for the menu phase.
  var inboundOpts = null;
  if (this._businessInbound) {
    var ivrCfg = null;
    try { ivrCfg = new ivrMod.IvrStore(this.dataDir || '.', this.keyHash).get(); } catch (e) {}
    inboundOpts = { keyHash: this.keyHash, from: this._businessInbound.from, dataDir: this.dataDir || '.', ivrConfig: ivrCfg };
    this._businessInbound = null;
  }
  var session = this.createSession({
    sdk: this.sdk,
    store: null,
    apiKey: key,
    models: models,
    role: agent.niche,
    voice: agent.voice,
    agentId: agent.id,
    agentName: agent.name,
    keyHash: this.keyHash,
    customStore: this.customStore,
    inbound: inboundOpts,
    systemInstruction: prompt.buildAgentInstruction(agent, recallText, customDir, teamCfg),
    onEvent: function (ev) { self.onEvent(ev); }
  });
  this.session = session;
  session.start();
};

Bridge.prototype.onEvent = function (ev) {
  var self = this;
  if (ev.type === 'setup_complete' && !this.connected) {
    this.connected = true;
    this._connectAt = Date.now(); // v7 usage metering baseline
    var info = { agentId: this.agent.id, agentName: this.agent.name, number: this.agent.number };
    var self2 = this;
    this._logStartP = this.history.logStart(info).then(function (id) {
      self2.callId = id;
      if (self2.alive && id) self2.send({ type: 'call_id', callId: id }); // client needs it for recordings/summaries
      return id;
    }).catch(function () { return null; });
    if (this.memory) {
      this._memP = this.memory.beginCall(Object.assign({ keyHash: this.keyHash }, info))
        .then(function (id) { self2.memId = id; return id; }).catch(function () { return null; });
    }
    // v7.5: link the history call id (call_...) onto the memory entry
    // (mem_...) so the Memory page can offer the device recording download
    // for the same call. Non-fatal — never blocks the call.
    if (this.memory) {
      var memPL = this._memP, memoryL = this.memory;
      this._logStartP.then(function (callId) {
        if (!callId || !memPL) return null;
        return memPL.then(function (memId) {
          if (memId && memoryL) return memoryL.setCallId(memId, callId);
          return null;
        });
      }).catch(function () {});
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
  if (ev.type === 'transfer_requested') {
    // SymAgent handed the caller to a specialist. Tell the phone UI which
    // agent is taking over, finalize the memory, then close after a short
    // grace delay so the spoken handoff finishes.
    this.send({ type: 'transfer', target: ev.target });
    this.finalizeMemory();
    var s2 = this;
    setTimeout(function () { s2.shutdown(); }, TRANSFER_DELAY_MS);
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
  // v7 usage metering + audit on call end, then ALWAYS release the
  // rate-limit slot (shutdown runs on both close and error).
  if (this.keystore && this.keyHash) {
    try {
      if (this.connected && this._connectAt) {
        var minutes = Math.max(0, (Date.now() - this._connectAt) / 60000);
        this.keystore.recordCall(this.keyHash, minutes).catch(function () {});
      }
      this.keystore.audit({
        keyHash: this.keyHash, label: '',
        event: 'call_end', agentId: this.agent ? this.agent.id : null
      }).catch(function () {});
      this.keystore.release(this.keyHash);
    } catch (e) { /* non-fatal */ }
  }
  this.finalizeMemory();
  try { if (this.session) this.session.hangup(); } catch (e) {}
  this.session = null;
  try { this.ws.close(); } catch (e) {}
};

module.exports = { Bridge: Bridge, DEFAULT_MODELS: DEFAULT_MODELS, publicAgent: publicAgent, keyHashOf: keyHashOf };
