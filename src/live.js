'use strict';
/**
 * src/live.js — server-side Gemini Live session manager for OMNI.
 *
 * Uses the official @google/genai SDK (ai.live.connect). The browser never
 * talks to Google directly and the API key is never in a URL.
 *
 * Guarantees:
 * - Exactly one 'setup_complete' event per fresh session, emitted only after
 *   Google actually confirms setup (never optimistic).
 * - Exactly one greeting per fresh session (none after a successful resume).
 * - One Live session at a time per bridge; hangup closes it and clears the key.
 * - Slow exponential backoff on reconnect (5/10/20/40s cap), no retry storm.
 * - Resumption only via official sessionResumption handles; no claim of
 *   restored context unless the server confirms.
 * - No logging of API keys, raw audio, or transcript contents.
 */

var prompt = require('./prompt');
var search = require('./search');

var BACKOFFS = [5000, 10000, 20000, 40000];

function maskError(e) {
  var m = String((e && e.message) || e || 'unknown error');
  // Redact anything that looks like a key.
  return m.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]').slice(0, 300);
}

function toolDeclarations(Type, agentId) {
  var decls = [
    {
      name: 'get_datetime',
      description: 'Return the current date and time. Use for any date/time question instead of guessing.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    {
      name: 'web_search',
      description: 'Search the web for CURRENT facts only (news, prices, hours, schedules, locations). Do not use for ordinary conversation. If it reports unavailable, tell the user search is unavailable.',
      parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: 'Search query' } }, required: ['query'] }
    },
    {
      name: 'save_note',
      description: 'Record ONE important fact from this call that the caller would want remembered (appointment with date/time, name, preference, decision). Call it right after the fact is confirmed. One fact per call.',
      parameters: { type: Type.OBJECT, properties: { note: { type: Type.STRING, description: 'The fact to remember' } }, required: ['note'] }
    },
    {
      name: 'end_call',
      description: 'End the phone call. Call this ONLY after you have said your spoken goodbye AND the caller clearly wants to hang up (they asked, or said a final goodbye). Never call it for any other reason.',
      parameters: { type: Type.OBJECT, properties: {} }
    }
  ];
  // SymAgent only: share official company links as clickable cards in chat.
  if (agentId === 'symagent') {
    decls.push({
      name: 'share_links',
      description: 'Share official Symbiote Systems links as clickable cards in the caller\'s chat. Use when the caller asks for socials, website, portfolio, or contact details. Mention the key links briefly in speech too.',
      parameters: {
        type: Type.OBJECT,
        properties: { set: { type: Type.STRING, description: 'Which links: "socials", "portfolio", "contact", or "all"' } },
        required: ['set']
      }
    });
  }
  return decls;
}

/** Official Symbiote Systems links — server-side only, the model can never inject its own URLs. */
var LINK_SETS = {
  socials: [
    { label: 'Instagram', url: 'https://www.instagram.com/symbiotesystems/' },
    { label: 'Threads', url: 'https://www.threads.com/@symbiotesystems' },
    { label: 'X (Twitter)', url: 'https://x.com/SymbioteSystems' },
    { label: 'LinkedIn', url: 'https://www.linkedin.com/in/faizanaliabbas/' },
    { label: 'Pinterest', url: 'https://www.pinterest.com/symbiotesystems/' },
    { label: 'Gumroad', url: 'https://symbiotesystems.gumroad.com/' }
  ],
  portfolio: [
    { label: 'Main portfolio', url: 'https://symbiotesystems.vercel.app/' },
    { label: 'Portfolio site', url: 'https://symbiotesystemsportfolio.vercel.app/' },
    { label: 'Aquifer Reach LLC — client work', url: 'https://aquiferreachllc.vercel.app/' }
  ],
  contact: [
    { label: 'Email', url: 'mailto:symbiotesystemsofficial@gmail.com' },
    { label: 'WhatsApp', url: 'https://wa.me/923142580054' }
  ]
};
function linksForSet(set) {
  if (set === 'all') return LINK_SETS.socials.concat(LINK_SETS.portfolio, LINK_SETS.contact);
  return LINK_SETS[set] || null;
}

/**
 * opts: { apiKey, models[], role, voice, store, onEvent, sdk, systemInstruction?, agentName? }
 * onEvent(ev) where ev = { type, ... }
 */
function createOmniSession(opts) {
  var sdk = opts.sdk; // { GoogleGenAI, Modality, Type }
  var store = opts.store;
  var onEvent = opts.onEvent || function () {};

  var state = {
    apiKey: opts.apiKey || null,
    models: opts.models && opts.models.length ? opts.models.slice() : ['gemini-3.8-live'],
    role: opts.role || 'general assistant',
    voice: opts.voice || 'Kore',
    systemInstruction: opts.systemInstruction || null,
    agentName: opts.agentName || null,
    agentId: opts.agentId || null,
    session: null,
    setupConfirmed: false,
    greeted: false,
    closed: false,
    resumeHandle: null,
    resumeSupported: false,
    backoffIdx: 0,
    reconnectTimer: null,
    diag: { framesToGoogle: 0, framesFromGoogle: 0, toolCalls: 0, turns: 0 }
  };

  function emit(ev) { try { onEvent(ev); } catch (e) { /* never break session on handler error */ } }

  function liveConfig() {
    return {
      responseModalities: [sdk.Modality.AUDIO],
      systemInstruction: state.systemInstruction || prompt.buildSystemInstruction(state.role),
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: state.voice } } },
      tools: [{ functionDeclarations: toolDeclarations(sdk.Type, state.agentId) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: state.resumeHandle ? { handle: state.resumeHandle } : {}
      // realtimeInputConfig omitted: automatic activity detection is the documented default.
    };
  }

  async function connectOnce(model) {
    var ai = new sdk.GoogleGenAI({ apiKey: state.apiKey });
    var session = await ai.live.connect({
      model: model,
      config: liveConfig(),
      callbacks: {
        onopen: function () { /* setup confirmation comes via setupComplete message */ },
        onmessage: handleMessage,
        onerror: function (e) { emit({ type: 'error', message: 'Live error: ' + maskError(e) }); },
        onclose: function (e) { handleClose(e); }
      }
    });
    return session;
  }

  async function start() {
    if (state.closed) return;
    var lastErr = null;
    for (var i = 0; i < state.models.length; i++) {
      var model = state.models[i];
      try {
        state.session = await connectOnce(model);
        state.model = model;
        return; // wait for setupComplete message
      } catch (e) {
        lastErr = e;
        var msg = maskError(e);
        // Only fall through the model chain on not-found/unsupported.
        if (!/not found|not supported|unsupported|invalid model/i.test(msg)) break;
        emit({ type: 'diag', note: 'model rejected, trying fallback', model: model });
      }
    }
    emit({ type: 'error', message: 'Could not start Live session: ' + maskError(lastErr), fatal: true });
  }

  function handleMessage(message) {
    if (!message || state.closed) return;
    // Any model output cancels the greeting watchdog.
    if (message.toolCall || (message.serverContent && (message.serverContent.modelTurn || message.serverContent.outputTranscription))) {
      state._gotModelOutput = true;
      if (state._greetTimer) { clearTimeout(state._greetTimer); state._greetTimer = null; }
    }
    try {
      if (message.setupComplete && !state.setupConfirmed) {
        state.setupConfirmed = true;
        state.backoffIdx = 0;
        emit({ type: 'setup_complete', model: state.model, resumed: !!state._resumed });
        state._resumed = false;
        if (!state.greeted) {
          state.greeted = true;
          var who = state.agentName ? state.agentName : 'the assistant';
          // Exactly one greeting trigger, sent as a completed text turn.
          state.session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: '[Call started — greet the caller now, briefly, as ' + who + ', in their language. Then wait.]' }] }],
            turnComplete: true
          });
          // Watchdog: if the model produces no output at all, nudge once.
          // (Covers edge cases where the first turn is silently swallowed.)
          var nudgeMs = opts.greetingNudgeMs || 12000;
          state._greetTimer = setTimeout(function () {
            if (state.closed || state._gotModelOutput || !state.session) return;
            try {
              state.session.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: '[Please say your greeting now.]' }] }],
                turnComplete: true
              });
              emit({ type: 'diag', note: 'greeting nudge sent' });
            } catch (e) { /* ignore */ }
          }, nudgeMs);
        }
        return;
      }
      if (message.sessionResumptionUpdate) {
        var u = message.sessionResumptionUpdate;
        if (u.newHandle) { state.resumeHandle = u.newHandle; state.resumeSupported = !!u.resumable; }
        return;
      }
      if (message.goAway) {
        emit({ type: 'go_away' });
        scheduleReconnect(true);
        return;
      }
      if (message.toolCall && message.toolCall.functionCalls) {
        message.toolCall.functionCalls.forEach(function (fc) { runTool(fc); });
        return;
      }
      var sc = message.serverContent;
      if (sc) {
        if (sc.inputTranscription && sc.inputTranscription.text) {
          emit({ type: 'transcript', who: 'user', text: sc.inputTranscription.text, final: true });
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
          emit({ type: 'transcript', who: 'omni', text: sc.outputTranscription.text, final: true });
        }
        if (sc.modelTurn && sc.modelTurn.parts) {
          sc.modelTurn.parts.forEach(function (p) {
            if (p.inlineData && p.inlineData.data) {
              state.diag.framesFromGoogle++;
              emit({ type: 'audio', data: p.inlineData.data, mimeType: p.inlineData.mimeType || 'audio/pcm;rate=24000' });
            } else if (p.text) {
              emit({ type: 'transcript', who: 'omni', text: p.text, final: false });
            }
          });
        }
        if (sc.interrupted) emit({ type: 'interrupted' });
        if (sc.turnComplete) { state.diag.turns++; emit({ type: 'turn_complete' }); }
      }
    } catch (e) {
      emit({ type: 'error', message: 'message handling: ' + maskError(e) });
    }
  }

  async function runTool(fc) {
    state.diag.toolCalls++;
    var result = await executeTool(fc.name, fc.args || {}, { store: store, emit: emit });
    try {
      state.session.sendToolResponse({ functionResponses: [{ name: fc.name, id: fc.id, response: result }] });
    } catch (e) {
      emit({ type: 'error', message: 'tool response failed: ' + maskError(e) });
    }
  }

  function handleClose(e) {
    if (state.closed) return;
    // Unexpected drop: try to resume with backoff.
    emit({ type: 'status', state: 'reconnecting' });
    scheduleReconnect(false);
  }

  function scheduleReconnect(wasGoAway) {
    if (state.closed || state.reconnectTimer) return;
    var delay = BACKOFFS[Math.min(state.backoffIdx, BACKOFFS.length - 1)];
    state.backoffIdx++;
    try { if (state.session) state.session.close(); } catch (e) {}
    state.session = null;
    state.setupConfirmed = false;
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      if (state.closed) return;
      if (state.resumeHandle && state.resumeSupported) {
        state._resumed = true; // attempt resume; greeting stays suppressed
        emit({ type: 'diag', note: 'attempting session resume' });
      } else {
        state.resumeHandle = null;
      }
      start();
    }, delay);
  }

  // ---- public API (called by the bridge) ----
  return {
    start: start,
    sendAudio: function (base64) {
      if (!state.session || !state.setupConfirmed) return false;
      // Drop silence-only frames to save quota (cheap energy check).
      try {
        var buf = Buffer.from(base64, 'base64');
        var sum = 0, n = Math.min(buf.length, 3200);
        for (var i = 0; i < n; i += 2) { var s = buf.readInt16LE(i); sum += s * s; }
        if (n > 0 && Math.sqrt(sum / (n / 2)) < 60) return true; // silent: skip send
        state.session.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } });
        state.diag.framesToGoogle++;
        return true;
      } catch (e) { return false; }
    },
    sendText: function (text) {
      if (!state.session || !state.setupConfirmed) return false;
      state.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: String(text) }] }], turnComplete: true });
      return true;
    },
    changeRole: function (role) {
      state.role = role;
      if (state.session && state.setupConfirmed) {
        state.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: '[SYSTEM] The user changed your role to: "' + String(role).slice(0, 200) + '". Acknowledge briefly and continue in the new role.' }] }],
          turnComplete: true
        });
      }
    },
    injectSystem: function (text) {
      if (state.session && state.setupConfirmed) {
        state.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '[SYSTEM] ' + text }] }], turnComplete: true });
      }
    },
    getDiag: function () { return Object.assign({ model: state.model }, state.diag); },
    hangup: function () {
      state.closed = true;
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      if (state._greetTimer) { clearTimeout(state._greetTimer); state._greetTimer = null; }
      try { if (state.session) state.session.close(); } catch (e) {}
      state.session = null;
      state.apiKey = null; // key lives in memory only for the session
    }
  };
}

/**
 * Execute one model tool call. Pure logic (no session needed) so tests can
 * drive the exact model-tool path. ctx = { emit }.
 */
async function executeTool(name, args, ctx) {
  var emit = (ctx && ctx.emit) || function () {};
  try {
    if (name === 'get_datetime') {
      var d = new Date();
      return { ok: true, iso: d.toISOString(), local: d.toString() };
    }
    if (name === 'web_search') {
      emit({ type: 'search_status', state: 'searching' });
      var r = await search.webSearch(args.query);
      emit({ type: 'search_status', state: 'done' });
      return r.unavailable ? { ok: false, error: 'search unavailable: ' + r.reason } : { ok: true, results: r.results };
    }
    if (name === 'save_note') {
      var note = String((args && args.note) || '').trim().slice(0, 500);
      if (!note) return { ok: false, error: 'empty note' };
      emit({ type: 'note_saved', note: note });
      return { ok: true, saved: true };
    }
    if (name === 'end_call') {
      emit({ type: 'end_call_requested' });
      return { ok: true, ending: true, note: 'Say nothing more; the call is ending now.' };
    }
    if (name === 'share_links') {
      var links = linksForSet(String((args && args.set) || '').toLowerCase());
      if (!links) return { ok: false, error: 'unknown link set (use socials, portfolio, contact, or all)' };
      emit({ type: 'links_shared', set: args.set, links: links });
      return { ok: true, shared: links.length };
    }
    return { ok: false, error: 'unknown tool: ' + name };
  } catch (e) {
    return { ok: false, error: maskError(e) };
  }
}

module.exports = { createOmniSession: createOmniSession, executeTool: executeTool, BACKOFFS: BACKOFFS };
