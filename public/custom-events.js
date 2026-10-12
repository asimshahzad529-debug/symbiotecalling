'use strict';
/**
 * public/custom-events.js — v7.5 custom-agent change notifications.
 *
 * Problem: creating/editing/deleting a custom agent must refresh the Agents
 * list AND the dialer immediately (no page reload), and only with the
 * ACTIVE key's agents. Solution: a single `custom-agents-changed` event
 * emitted after every successful save/delete. Subscribers (app.js: the
 * directory renderer + the dialer data source) re-merge the agent list for
 * the active key.
 *
 * Two transports, one event:
 *   1. Pure channel (node-testable): CustomAgentChannel with subscribe /
 *      unsubscribe / emit. No DOM needed — unit tests exercise the whole
 *      subscribe -> emit -> handler flow here.
 *   2. Browser DOM transport (browser-only): emitChanged() also dispatches
 *      a real DOM CustomEvent('custom-agents-changed', { detail }) on
 *      `window`, so modules that never import this file (e.g. app.js via
 *      window.addEventListener) still hear it. Guarded by typeof window —
 *      never runs in node.
 *
 * ================= INTEGRATOR CONTRACT =================
 * 1. index.html: <script src="custom-events.js"></script> BEFORE
 *    custom-agents.js (emitter) — app.js may load after; it only needs
 *    window.CustomAgentEvents at subscription time.
 * 2. Emitters (custom-agents.js): after a successful create/update/delete,
 *    call window.CustomAgentEvents.emitChanged({ action, id }) — guarded:
 *      if (window.CustomAgentEvents) window.CustomAgentEvents.emitChanged({...});
 * 3. Subscribers (app.js): window.addEventListener('custom-agents-changed',
 *    refreshFn) where refreshFn re-fetches + re-merges the agent list for
 *    the active key and re-renders the directory (the dialer reads the same
 *    merged list, so both update together).
 * =========================================================
 */
(function (global) {
  var CHANGED_EVENT = 'custom-agents-changed';

  /**
   * CustomAgentChannel — tiny typed event channel. Pure: no DOM, no I/O,
   * safe to unit test in node. subscribe() returns an unsubscribe function.
   * A throwing handler never breaks the other handlers or the emitter.
   */
  function CustomAgentChannel() {
    this._handlers = [];
  }
  CustomAgentChannel.prototype.subscribe = function (fn) {
    if (typeof fn !== 'function') throw new Error('subscribe requires a function');
    this._handlers.push(fn);
    var self = this;
    return function unsubscribe() { self.unsubscribe(fn); };
  };
  CustomAgentChannel.prototype.unsubscribe = function (fn) {
    this._handlers = this._handlers.filter(function (h) { return h !== fn; });
    return this._handlers.length;
  };
  CustomAgentChannel.prototype.handlerCount = function () { return this._handlers.length; };
  /**
   * emit(detail) — notify pure subscribers, then (browser-only) dispatch a
   * DOM CustomEvent on window so plain window.addEventListener subscribers
   * hear it too. Returns the number of pure handlers notified.
   */
  CustomAgentChannel.prototype.emit = function (detail) {
    var d = detail && typeof detail === 'object' ? detail : {};
    var handlers = this._handlers.slice();
    handlers.forEach(function (fn) {
      try { fn(d); } catch (e) { /* one bad handler must not break the rest */ }
    });
    // Browser-only DOM transport.
    try {
      if (typeof window !== 'undefined' && window && typeof window.dispatchEvent === 'function') {
        var ev = null;
        if (typeof window.CustomEvent === 'function') {
          ev = new window.CustomEvent(CHANGED_EVENT, { detail: d });
        } else if (typeof document !== 'undefined' && typeof document.createEvent === 'function') {
          ev = document.createEvent('CustomEvent');
          ev.initCustomEvent(CHANGED_EVENT, false, false, d);
        }
        if (ev) window.dispatchEvent(ev);
      }
    } catch (e) { /* DOM transport is best-effort */ }
    return handlers.length;
  };

  // Shared singleton: emitters and subscribers use the same channel.
  var channel = new CustomAgentChannel();

  var api = {
    CHANGED_EVENT: CHANGED_EVENT,
    CustomAgentChannel: CustomAgentChannel,
    /** The shared channel instance. */
    channel: channel,
    /** Emit on the shared channel (pure subscribers + DOM event). */
    emitChanged: function (detail) { return channel.emit(detail); },
    /** Subscribe on the shared channel; returns an unsubscribe function. */
    onChanged: function (fn) { return channel.subscribe(fn); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CustomAgentEvents = api;
})((typeof window !== 'undefined') ? window : global);
