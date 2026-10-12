'use strict';
/* public/greeting.js — window.GreetingDiag: client-side greeting-handshake
 * diagnostics for Symbiote Calling v7 (WS3 greeting fix).
 *
 * Pure logic, no DOM writes. The integrator wires UI from getReport() or the
 * raw timeline, e.g.:
 *   trigger_sent / retry_sent       -> show "greeting…" indicator
 *   audio_received                  -> normal call UI (audio is playing)
 *   text_received / greeting_text_only -> transcript bubble with the text
 *   failed / greeting_failed        -> "Say hello to begin" hint
 *
 * Usage:
 *   var diag = GreetingDiag.attach(function (listener) {
 *     bridgeOnEvent(listener);          // subscribe; may return an unsubscribe fn
 *   });
 *   // ... later, e.g. in a diagnostics panel:
 *   var r = GreetingDiag.getReport();
 *   // -> { triggerSent, retried, firstOutputMs, outputKind, failed }
 *
 * reset() is test-only; production code never needs it.
 */
(function () {
  var timeline = [];
  var rep = null;
  var t0 = 0;

  function freshRep() {
    return { triggerSent: false, retried: false, firstOutputMs: null, outputKind: null, failed: false, text: null };
  }
  rep = freshRep();

  // Feed one bridge event into the timeline. Unknown event types are
  // recorded but ignored, so this is safe to wire into a shared onEvent.
  function note(ev) {
    timeline.push({ at: Date.now(), ev: ev });
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'greeting_state') {
      var d = ev.detail || {};
      if (ev.state === 'trigger_sent') { rep.triggerSent = true; t0 = Date.now(); }
      else if (ev.state === 'retry_sent') { rep.retried = true; }
      else if (ev.state === 'audio_received' || ev.state === 'text_received') {
        rep.outputKind = (ev.state === 'audio_received') ? 'audio' : 'text';
        rep.firstOutputMs = (typeof d.latencyMs === 'number') ? d.latencyMs : (t0 ? Date.now() - t0 : null);
        if (d.text) rep.text = d.text;
      }
      else if (ev.state === 'failed') { rep.failed = true; }
    } else if (ev.type === 'greeting_text_only') {
      if (ev.text) rep.text = ev.text;
    } else if (ev.type === 'greeting_failed') {
      rep.failed = true;
    }
  }

  function attach(subscribe) {
    var unsub = null;
    if (typeof subscribe === 'function') {
      try { unsub = subscribe(note) || null; } catch (e) { /* ignore */ }
    }
    return {
      feed: note,
      getReport: getReport,
      timeline: function () { return timeline.slice(); },
      detach: function () { if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* ignore */ } } }
    };
  }

  function getReport() {
    return {
      triggerSent: rep.triggerSent,
      retried: rep.retried,
      firstOutputMs: rep.firstOutputMs,
      outputKind: rep.outputKind,
      failed: rep.failed
    };
  }

  function reset() {
    timeline = [];
    rep = freshRep();
    t0 = 0;
  }

  window.GreetingDiag = { attach: attach, getReport: getReport, reset: reset };
})();

/* ------------------------------------------------------------------
 * window.GreetingMask — UX "greeting mask" for the call overlay
 * (Symbiote Calling v7.5.0 fixing release).
 *
 * User diagnosis: agents actually greet ~5s after the Live session
 * connects (model warmup), so users feel dead silence. The mask keeps
 * the call overlay on "Connecting…" from tap until the FIRST greeting
 * output frame arrives, then reveals the live call UI at that exact
 * moment — the user perceives the greeting the instant the call
 * connects.
 *
 * Hard cap DEFAULT_TIMEOUT_MS (7000ms): if no greeting output by
 * then, reveal anyway with the existing "Say hello to begin"
 * fallback hint.
 *
 * State machine: idle -> masking -> revealed | revealed_fallback.
 * Exactly-once reveal: late audio after a timeout reveal is a no-op
 * (returns false), so the UI can never double-reveal or glitch.
 *
 * Pure logic, no DOM, no mic surface: the mask NEVER touches the mic
 * gate — mic stays gated until greeting audio / the existing 10s
 * fallback (see app.js ungateMic, untouched). It consumes the same
 * greeting_state events the v7 handshake emits; it does not replace
 * them or GreetingDiag. The integrator wires DOM from onMask/onReveal
 * and feeds first output via onAudio(kind); the timeout is a real
 * timer (override setTimer/clearTimer for tests).
 *
 * UNVERIFIED-LIVE: real-call timing (warmup latency, 7s cap feel)
 * needs a live-key call to confirm.
 * ------------------------------------------------------------------ */
(function () {
  var DEFAULT_TIMEOUT_MS = 7000; // hard cap: reveal anyway past this

  function create(opts) {
    opts = opts || {};
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs >= 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var setT = (typeof opts.setTimer === 'function') ? opts.setTimer : setTimeout;
    var clearT = (typeof opts.clearTimer === 'function') ? opts.clearTimer : clearTimeout;
    var onMask = (typeof opts.onMask === 'function') ? opts.onMask : null;
    var onReveal = (typeof opts.onReveal === 'function') ? opts.onReveal : null;

    var state = 'idle'; // idle -> masking -> revealed | revealed_fallback
    var timer = null;

    function clearTimer() {
      if (timer !== null) { try { clearT(timer); } catch (e) {} timer = null; }
    }
    function reveal(how) {
      if (state !== 'masking') return false; // exactly-once: late events are no-ops
      clearTimer();
      if (how === 'fallback') { state = 'revealed_fallback'; }
      else { state = 'revealed'; how = (how === 'text') ? 'text' : 'audio'; }
      if (onReveal) { try { onReveal(how); } catch (e) {} }
      return true;
    }

    return {
      // Begin masking; returns false if already masking (no double arm).
      start: function () {
        if (state === 'masking') return false;
        state = 'masking';
        try { timer = setT(function () { reveal('fallback'); }, timeoutMs); } catch (e) { timer = null; }
        if (onMask) { try { onMask(); } catch (e) {} }
        return true;
      },
      // First greeting output arrived: kind 'audio' | 'text'.
      onAudio: function (kind) { return reveal(kind === 'text' ? 'text' : 'audio'); },
      // Manual/test trigger for the fallback path (normally the timer).
      onTimeout: function () { return reveal('fallback'); },
      // Back to idle; clears any pending timer. Called on call teardown.
      reset: function () { clearTimer(); state = 'idle'; },
      isMasking: function () { return state === 'masking'; },
      getState: function () { return state; }
    };
  }

  window.GreetingMask = { create: create, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS };
})();
