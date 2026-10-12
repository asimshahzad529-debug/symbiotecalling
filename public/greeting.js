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
