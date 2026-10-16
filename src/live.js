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
var agents = require('./agents');
var customAgents = require('./customAgents');
var businessLine = require('./businessLine');
var ivr = require('./ivr');

var BACKOFFS = [5000, 10000, 20000, 40000];

function maskError(e) {
  var m = String((e && e.message) || e || 'unknown error');
  // Redact anything that looks like a key.
  return m.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED]').slice(0, 300);
}

/**
 * v8 ERR-server: map a raw Gemini Live API error to a user-friendly
 * { code, message }. No keys, no stack traces, no SDK internals in the
 * message. The session emits these as {type:'live_error', code, message};
 * the frontend worker consumes exactly that shape.
 */
function friendlyLiveError(e) {
  var raw = String((e && e.message) || e || '').toLowerCase();
  if (/api key|apikey|401|403|permission denied|invalid key/.test(raw)) {
    return { code: 'auth_failed', message: 'Your API key was rejected by Google. Check the key in Settings.' };
  }
  if (/429|quota|resource exhausted|rate limit/.test(raw)) {
    return { code: 'quota_exceeded', message: 'Google API quota exceeded for this key. Try again later or use another key.' };
  }
  if (/not found|not supported|unsupported|invalid model/.test(raw)) {
    return { code: 'model_unavailable', message: 'The selected model is unavailable right now. Trying another model…' };
  }
  if (/network|econnrefused|enotfound|etimedout|fetch failed|socket/.test(raw)) {
    return { code: 'network_error', message: 'Could not reach Google. Check your connection and try again.' };
  }
  if (/websocket|close/.test(raw)) {
    return { code: 'session_dropped', message: 'The voice session dropped unexpectedly.' };
  }
  return { code: 'session_error', message: 'The voice session hit a problem and could not start.' };
}

/** Emit {type:'live_error', code, message}; also keeps the legacy 'error' event for old handlers. */
function emitLiveError(emit, e, fatal) {
  var f = friendlyLiveError(e);
  emit({ type: 'live_error', code: f.code, message: f.message, fatal: !!fatal });
  emit({ type: 'error', message: 'Live error: ' + maskError(e), code: f.code, fatal: !!fatal });
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
  // SymAgent only: transfer the caller to a specialist agent mid-call.
  if (agentId === 'symagent') {
    decls.push({
      name: 'transfer_call',
      description: 'Transfer the caller to a specialist agent mid-call. Call ONLY after you have said your one brief handoff sentence. Pass the agent id or the full phone number of the specialist.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Specialist agent id (e.g. "lina")' },
          number: { type: Type.STRING, description: 'Specialist agent phone number, e.g. "+1 (555) 010-0003"' }
        }
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
 * Resolve a transfer_call target to a public agent record.
 * Returns { ok:true, target:{id,name,number,niche} } or { ok:false, error }.
 * Rejects: missing/empty args, unknown agent id or number, self-transfer.
 */
function resolveTransferTarget(args, ctx) {
  if (!args || typeof args !== 'object') return { ok: false, error: 'missing arguments: pass agentId or number' };
  var id = args.agentId ? String(args.agentId).trim() : '';
  var number = args.number ? String(args.number).trim() : '';
  if (!id && !number) return { ok: false, error: 'missing arguments: pass agentId or number' };
  var target = id ? agents.getById(id) : agents.getByNumber(number);
  // v7: after the built-in lookup fails, fall back to the caller's custom
  // agents (per-key store). Custom agents never carry transfer_call
  // themselves (toolNamesFor stays SymAgent-only), but SymAgent CAN hand
  // a caller to them.
  if (!target && ctx && ctx.customStore) {
    var custom = customAgents.findTarget(ctx.customStore, ctx.keyHash, id || number);
    if (custom) {
      if (custom.id === 'symagent') return { ok: false, error: 'cannot transfer to yourself' };
      return { ok: true, target: { id: custom.id, name: custom.name, number: custom.number, niche: custom.role } };
    }
  }
  if (!target) return { ok: false, error: id ? 'unknown agent id: ' + id.slice(0, 40) : 'unknown number: ' + number.slice(0, 40) };
  if (target.id === 'symagent') return { ok: false, error: 'cannot transfer to yourself' };
  return { ok: true, target: { id: target.id, name: target.name, number: target.number, niche: target.niche } };
}

/** Tool names available for one agent id (no SDK Type object needed), for gating checks. */
function toolNamesFor(agentId) {
  var fakeType = { OBJECT: 'OBJECT', STRING: 'STRING' };
  return toolDeclarations(fakeType, agentId).map(function (d) { return d.name; });
}

/* ---------------------------------------------------------------------------
 * WS3 GREETING FIX (v7.0.0) — pure greeting-handshake helpers.
 *
 * P0 bug: on real calls no agent ever greets first; the old trigger turn
 * produced no model output. UNVERIFIED-LIVE: with no live API key available
 * we cannot prove WHY (candidates: bracketed phrasing parsed as meta, text
 * turn racing session readiness, AUDIO-only session ignoring text turns).
 * These helpers are pure and unit-tested; the live behavior they assume is
 * marked UNVERIFIED-LIVE wherever it matters.
 * ------------------------------------------------------------------------- */

/**
 * Direct-instruction trigger phrasing (T+0). Deliberately NOT bracketed:
 * UNVERIFIED-LIVE, but bracketed text looks like a meta-instruction a model
 * may silently acknowledge instead of speaking, so a plain imperative is
 * the more robust bet.
 */
function greetingTriggerText(agentName) {
  return 'Greet the caller now with a brief hello as ' + agentName + '.';
}

/** Variant phrasing for the single ~6s retry (must differ from the trigger). */
function greetingRetryText(agentName) {
  return 'Please say your greeting now, ' + agentName + '.';
}

/**
 * Classify the first model output of a greeting handshake.
 * Returns null when the message carries no model output, else
 * { kind: 'audio' }            — modelTurn part with inlineData (spoken audio)
 * { kind: 'text', text }       — modelTurn text part or outputTranscription
 *                                (degraded: the model "spoke" but no audio)
 * { kind: 'tool', text: null } — bare toolCall (model is alive, no speech yet)
 * UNVERIFIED-LIVE: with AUDIO modality + outputAudioTranscription the first
 * output may be a transcription frame before any audio frame; kind 'text'
 * then correctly describes what the client can show.
 */
function greetingClassifyOutput(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.toolCall) return { kind: 'tool', text: null };
  var sc = message.serverContent;
  if (!sc || typeof sc !== 'object') return null;
  var mt = sc.modelTurn;
  if (mt && mt.parts && mt.parts.length) {
    var i, p;
    for (i = 0; i < mt.parts.length; i++) {
      p = mt.parts[i];
      if (p && p.inlineData && p.inlineData.data) return { kind: 'audio', text: null };
    }
    for (i = 0; i < mt.parts.length; i++) {
      p = mt.parts[i];
      if (p && p.text) return { kind: 'text', text: p.text };
    }
    return { kind: 'text', text: '' };
  }
  if (mt) return { kind: 'text', text: '' }; // bare modelTurn: output of unknown kind
  if (sc.outputTranscription) return { kind: 'text', text: sc.outputTranscription.text || '' };
  return null;
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
    keyHash: opts.keyHash || null,         // v7: transfer_call custom-agent fallback
    customStore: opts.customStore || null, // v7: per-key custom agent store
    session: null,
    setupConfirmed: false,
    greeted: false,
    closed: false,
    resumeNote: opts.resumeNote || null, // background resume: context note instead of greeting
    resumeHandle: null,
    resumeSupported: false,
    backoffIdx: 0,
    reconnectTimer: null,
    // WS3 greeting handshake state machine: idle -> trigger_sent ->
    // (audio_received | text_received | failed). Diag counters live here.
    greetHs: { phase: 'idle', triggerSentAt: 0, retrySentAt: 0, firstOutputAt: 0, outputKind: null },
    _greetRetryTimer: null,
    _greetFailTimer: null,
    // v8 #26/#13: business-line inbound call state. opts.inbound =
    // { keyHash, from, dataDir, ivrConfig?, setTimer?, clearTimer? }.
    inbound: opts.inbound || null,
    inboundTracker: null,
    menu: { phase: 'idle', config: null, timer: null },
    diag: { framesToGoogle: 0, framesFromGoogle: 0, toolCalls: 0, turns: 0 }
  };

  function emit(ev) { try { onEvent(ev); } catch (e) { /* never break session on handler error */ } }

  // v8 #26: track the inbound call for the missed-call log. If the session
  // never picks up (no setupComplete) within 30s, the tracker logs it as
  // missed. Fictional telephony — UNVERIFIED-LIVE.
  if (state.inbound) {
    try {
      state.inboundTracker = businessLine.trackInboundCall({
        dataDir: state.inbound.dataDir || '.',
        keyHash: state.inbound.keyHash,
        from: state.inbound.from,
        setTimer: state.inbound.setTimer,
        clearTimer: state.inbound.clearTimer
      });
    } catch (e) { /* tracker failure must not kill the call */ }
  }

  function liveConfig() {
    return {
      responseModalities: [sdk.Modality.AUDIO],
      // WS1 renamed prompt.buildSystemInstruction -> buildAgentInstruction;
      // the fallback here builds a minimal agent so a session started
      // without an explicit instruction (bridge always passes one) still
      // gets a valid prompt.
      systemInstruction: state.systemInstruction || prompt.buildAgentInstruction({
        id: state.agentId || 'agent',
        name: state.agentName || 'Assistant',
        gender: null,
        niche: state.role,
        number: '',
        voice: state.voice,
        prompt: '',
        knowledge: null
      }, null),
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
        onerror: function (e) { emitLiveError(emit, e, false); },
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
    emitLiveError(emit, lastErr, true);
  }

  function handleMessage(message) {
    if (!message || state.closed) return;
    // WS3: any model output resolves the greeting handshake (audio vs
    // text-only distinguished) and cancels the retry/fail timers.
    var _greetOut = greetingClassifyOutput(message);
    if (_greetOut) {
      state._gotModelOutput = true;
      greetResolve(_greetOut.kind, _greetOut.text);
    }
    try {
      if (message.setupComplete && !state.setupConfirmed) {
        state.setupConfirmed = true;
        state.backoffIdx = 0;
        if (state.resumeNote && !state._resumed) state._resumed = true; // background resume: flag the emit below
        emit({ type: 'setup_complete', model: state.model, resumed: !!state._resumed });
        state._resumed = false;
        /* -------------------------------------------------------------
         * WS3 GREETING HANDSHAKE — CONTRACT FOR INTEGRATOR
         * (no server.js changes needed; events below ride the existing
         * session onEvent channel which the bridge already forwards.)
         *
         * Event names / payloads:
         *  {type:'greeting_state', state:'trigger_sent',
         *   detail:{attempt:1}}
         *  {type:'greeting_state', state:'retry_sent',
         *   detail:{attempt:2}}
         *  {type:'greeting_state', state:'audio_received',
         *   detail:{outputKind:'audio', latencyMs:<ms since trigger>}}
         *  {type:'greeting_state', state:'text_received',
         *   detail:{outputKind:'text', latencyMs:<n>, text:'<first 300 chars>'}}
         *  {type:'greeting_state', state:'failed',
         *   detail:{outputKind:null, latencyMs:<n>}}
         *  {type:'greeting_text_only', text:'<full text>'}
         *    — degraded success (no audio frames); render as a transcript bubble.
         *  {type:'greeting_failed', hint:'Say hello to begin'}
         *    — silence after ~12s; the client mic already ungates itself,
         *      show the hint so the caller speaks first.
         *
         * Client display mapping:
         *  trigger_sent / retry_sent -> "greeting…" / connecting indicator
         *  audio_received            -> normal call UI (audio is playing)
         *  text_received / greeting_text_only -> transcript bubble with the text
         *  failed / greeting_failed  -> "Say hello to begin" hint
         *
         * Guarantees: exactly one trigger per fresh session (greeted flag;
         * none after resume); at most one retry; fail is terminal. Timings:
         * retry = opts.greetingNudgeMs || 6000, fail = opts.greetingFailMs
         * || 12000 (UNVERIFIED-LIVE: values are engineering guesses —
         * real greeting latency needs a live-key measurement).
         * ----------------------------------------------------------- */
        // v8 #26: the session picked up — the inbound call is answered.
        if (state.inboundTracker) { try { state.inboundTracker.answered(); } catch (e) {} }
        if (state.inbound && state.inbound.ivrConfig) {
          state.greeted = true; // menu replaces the standalone greeting
          startMenu();
        } else if (!state.greeted) {
          state.greeted = true;
          if (state.resumeNote) resumeWithNote(); // background resume: context note, no greeting
          else greetStart();
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

  /* WS3 greeting-handshake drivers (greeting block only; hoisted function
   * declarations, called from handleMessage above). */

  function greetEmit(st, detail) {
    emit({ type: 'greeting_state', state: st, detail: detail || {} });
  }

  // Background resume: the caller's tab went to background (e.g. they opened
  // the Play Store) and the client reconnected. Skip the greeting trigger
  // entirely; feed the resume note as context so the model continues naturally.
  function resumeWithNote() {
    var note = state.resumeNote; state.resumeNote = null;
    var hs = state.greetHs;
    hs.phase = 'resumed';
    try {
      state.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: note }] }],
        turnComplete: true
      });
    } catch (e) { /* transport failed; client-side retry covers it */ }
    greetEmit('resumed', {});
  }

  // Start the handshake on setupComplete: send the T+0 trigger, arm the
  // single ~6s retry and the ~12s failure timer.
  function greetStart() {
    var hs = state.greetHs;
    var who = state.agentName ? state.agentName : 'the assistant';
    hs.phase = 'trigger_sent';
    hs.triggerSentAt = Date.now();
    try {
      state.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: greetingTriggerText(who) }] }],
        turnComplete: true
      });
    } catch (e) { /* transport send failed; timers below still report state */ }
    greetEmit('trigger_sent', { attempt: 1 });
    var retryMs = opts.greetingNudgeMs || 6000;
    var failMs = opts.greetingFailMs || 12000;
    if (failMs < retryMs) failMs = retryMs + 1000; // failure must come after the retry
    state._greetRetryTimer = setTimeout(function () {
      state._greetRetryTimer = null;
      if (state.closed || !state.session || !state.greetHs || state.greetHs.phase !== 'trigger_sent') return;
      state.greetHs.retrySentAt = Date.now();
      try {
        state.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: greetingRetryText(who) }] }],
          turnComplete: true
        });
      } catch (e) { /* ignore */ }
      greetEmit('retry_sent', { attempt: 2 });
    }, retryMs);
    state._greetFailTimer = setTimeout(function () {
      state._greetFailTimer = null;
      greetFail();
    }, failMs);
  }

  // Resolve the handshake on first model output. Exactly-once: only the
  // transition out of 'trigger_sent' counts; later frames are ignored.
  function greetResolve(kind, text) {
    var hs = state.greetHs;
    if (!hs || hs.phase !== 'trigger_sent') return;
    var now = Date.now();
    hs.phase = (kind === 'audio') ? 'audio_received' : 'text_received';
    hs.firstOutputAt = now;
    hs.outputKind = kind;
    if (state._greetRetryTimer) { clearTimeout(state._greetRetryTimer); state._greetRetryTimer = null; }
    if (state._greetFailTimer) { clearTimeout(state._greetFailTimer); state._greetFailTimer = null; }
    var detail = { outputKind: kind, latencyMs: now - hs.triggerSentAt };
    if (text) detail.text = String(text).slice(0, 300);
    greetEmit(hs.phase, detail);
    if (kind !== 'audio' && text) {
      // Degraded success: no audio frames, but the model produced text.
      emit({ type: 'greeting_text_only', text: String(text).slice(0, 1000) });
    }
  }

  // Terminal failure: silence past the fail budget. Sends nothing more to
  // the model; the client ungates its mic on its own fallback and should
  // show the 'Say hello to begin' hint.
  function greetFail() {
    var hs = state.greetHs;
    if (!hs || hs.phase !== 'trigger_sent' || state.closed) return;
    hs.phase = 'failed';
    greetEmit('failed', { outputKind: null, latencyMs: Date.now() - hs.triggerSentAt });
    emit({ type: 'greeting_failed', hint: 'Say hello to begin' });
  }

  /* ---------------------------------------------------------------------------
   * v8 #13 — IVR menu phase (business-line inbound calls only).
   *
   * The menu REPLACES the standalone greeting handshake: on setupComplete the
   * receptionist gets one instruction turn (greet briefly, then speak the
   * menu). DTMF digits arrive via the public sendDtmf(digit) method (the
   * client forwards keypad presses) and are intercepted here — they never
   * reach the model. A mapped digit routes to the agent through the same
   * resolveTransferTarget() path transfer_call uses. No digit within
   * MENU_TIMEOUT_MS routes to defaultAgentId. UNVERIFIED-LIVE: the routing
   * logic is pure/tested; live DTMF timing depends on real-call testing.
   * ------------------------------------------------------------------------- */

  /** Route the inbound call to one agent id via the transfer machinery. Emits transfer_requested. */
  function menuRouteTo(agentId, source) {
    var tr = resolveTransferTarget({ agentId: agentId }, { customStore: state.customStore, keyHash: state.keyHash });
    if (!tr.ok) {
      emit({ type: 'ivr_error', detail: tr.error });
      return false;
    }
    emit({ type: 'transfer_requested', target: tr.target, source: source });
    return true;
  }

  function clearMenuTimer() {
    if (state.menu.timer) { clearTimeout(state.menu.timer); state.menu.timer = null; }
  }

  // Start the menu phase on setupComplete: instruct the receptionist to
  // greet briefly and speak the menu, then arm the no-digit timeout.
  function startMenu() {
    var cfg;
    try { cfg = ivr.normalizeConfig(state.inbound.ivrConfig); }
    catch (e) { emit({ type: 'ivr_error', detail: 'bad ivr config: ' + e.message }); return; }
    state.menu.config = cfg;
    state.menu.phase = 'active';
    var who = state.agentName ? state.agentName : 'the assistant';
    var say = 'This is an inbound call to the business line. Greet briefly as ' + who +
      ', then say this menu exactly once: "' + ivr.buildMenuPrompt(cfg) +
      '" Then wait silently for the caller to press a digit.';
    try {
      state.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: say }] }],
        turnComplete: true
      });
    } catch (e) { /* transport send failed; timeout below still routes */ }
    emit({ type: 'menu_state', state: 'menu_sent' });
    state.menu.timer = setTimeout(function () {
      state.menu.timer = null;
      if (state.closed || state.menu.phase !== 'active') return;
      state.menu.phase = 'resolved';
      emit({ type: 'menu_state', state: 'timeout', detail: { defaultAgentId: cfg.defaultAgentId } });
      menuRouteTo(cfg.defaultAgentId, 'ivr_timeout');
    }, ivr.MENU_TIMEOUT_MS);
  }

  /** Handle one DTMF digit during the menu phase. Returns true when consumed. */
  function handleDtmf(digit) {
    if (state.menu.phase !== 'active' || !state.menu.config) return false;
    var d = String(digit == null ? '' : digit).trim();
    if (!/^[0-9]$/.test(d)) return false; // not a menu digit; ignore
    var agentId = ivr.resolveDigit(state.menu.config, d);
    if (!agentId) {
      // Unmapped digit: keep the menu alive, tell the client to re-speak it.
      emit({ type: 'ivr_invalid_digit', digit: d });
      return true;
    }
    state.menu.phase = 'resolved';
    clearMenuTimer();
    emit({ type: 'menu_state', state: 'digit', detail: { digit: d, agentId: agentId } });
    menuRouteTo(agentId, 'ivr');
    return true;
  }

  async function runTool(fc) {
    state.diag.toolCalls++;
    var result = await executeTool(fc.name, fc.args || {}, {
      store: store, emit: emit,
      customStore: state.customStore, keyHash: state.keyHash
    });
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
    // v8 #13: DTMF digit pressed by the caller (keypad). Intercepted during
    // the menu phase; returns true when the digit was consumed by the menu.
    sendDtmf: function (digit) {
      return handleDtmf(digit);
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
    getDiag: function () {
      var g = state.greetHs;
      return Object.assign({ model: state.model }, state.diag, {
        greetingState: g.phase, triggerSentAt: g.triggerSentAt, retrySentAt: g.retrySentAt,
        firstOutputAt: g.firstOutputAt, outputKind: g.outputKind
      });
    },
    hangup: function () {
      state.closed = true;
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
      if (state._greetRetryTimer) { clearTimeout(state._greetRetryTimer); state._greetRetryTimer = null; }
      if (state._greetFailTimer) { clearTimeout(state._greetFailTimer); state._greetFailTimer = null; }
      clearMenuTimer();
      if (state.inboundTracker) { try { state.inboundTracker.ended(); } catch (e) {} }
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
    if (name === 'transfer_call') {
      var tr = resolveTransferTarget(args, { customStore: ctx.customStore, keyHash: ctx.keyHash });
      if (!tr.ok) return { ok: false, error: tr.error };
      emit({ type: 'transfer_requested', target: tr.target });
      return { ok: true, transfer: tr.target, note: 'Say one brief handoff sentence, then say nothing more; the transfer is being connected.' };
    }
    return { ok: false, error: 'unknown tool: ' + name };
  } catch (e) {
    return { ok: false, error: maskError(e) };
  }
}

module.exports = { createOmniSession: createOmniSession, executeTool: executeTool, BACKOFFS: BACKOFFS, resolveTransferTarget: resolveTransferTarget, toolNamesFor: toolNamesFor, greetingTriggerText: greetingTriggerText, greetingRetryText: greetingRetryText, greetingClassifyOutput: greetingClassifyOutput };
