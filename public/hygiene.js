'use strict';
/* public/hygiene.js — v7 hygiene (WS7).
 *
 * window.Hygiene (browser) / module.exports (node tests):
 *   Accent picker:   ACCENTS, sanitizeAccent(c), accentSoft(hex),
 *                    applyAccent(c), initAccent()
 *   Retention:       getRetentionDays(), setRetentionDays(n)
 *   History filters: filterHistory(calls, { agentId, from, to, status })
 *                    status: 'any' | 'completed' | 'missed'
 *                      completed = durationSec > 0
 *                      missed    = ended (endedAt set) with durationSec <= 0
 *   Recordings:      isOlderThan(iso, days) — for the IndexedDB prune on boot
 *
 * Accent is applied as --acc (app theme) and --kg-accent (keygate overlay),
 * and persisted in localStorage so it survives reloads.
 */
(function (global) {

  var LS_ACCENT = 'symbiote-accent';
  var LS_RETENTION = 'symbiote-retention-days';
  var DEFAULT_ACCENT = '#6d28d9';
  var DEFAULT_RETENTION = 30;

  var ACCENTS = [
    '#6d28d9', // symbiote violet (default)
    '#0e7490', // teal
    '#1d4ed8', // blue
    '#15803d', // green
    '#b45309', // amber
    '#be123c', // rose
    '#a21caf', // fuchsia
    '#0f766e'  // deep teal
  ];

  function sanitizeAccent(c) {
    var s = String(c == null ? '' : c).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    var m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
    if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    return DEFAULT_ACCENT;
  }

  function hexToRgb(hex) {
    var h = sanitizeAccent(hex);
    return {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16)
    };
  }

  // Soft tint of the accent for backgrounds: rgba(r,g,b,0.12)
  function accentSoft(hex) {
    var c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.12)';
  }

  function lsGet(k) {
    try { return global.localStorage ? global.localStorage.getItem(k) : null; } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (global.localStorage) global.localStorage.setItem(k, v); } catch (e) {}
  }

  function applyAccent(color) {
    var hex = sanitizeAccent(color);
    if (global.document && global.document.documentElement) {
      var st = global.document.documentElement.style;
      st.setProperty('--acc', hex);
      st.setProperty('--acc-soft', accentSoft(hex));
      st.setProperty('--kg-accent', hex);
      st.setProperty('--kg-accent-soft', accentSoft(hex));
    }
    lsSet(LS_ACCENT, hex);
    return hex;
  }

  function initAccent() {
    return applyAccent(lsGet(LS_ACCENT) || DEFAULT_ACCENT);
  }

  function getRetentionDays() {
    var n = parseInt(lsGet(LS_RETENTION), 10);
    if (!isFinite(n) || n < 1) return DEFAULT_RETENTION;
    if (n > 3650) return 3650;
    return n;
  }

  function setRetentionDays(n) {
    n = parseInt(n, 10);
    if (!isFinite(n) || n < 1) n = DEFAULT_RETENTION;
    if (n > 3650) n = 3650;
    lsSet(LS_RETENTION, String(n));
    return n;
  }

  function isOlderThan(iso, days, nowMs) {
    if (iso == null || iso === '') return false;
    var t = Date.parse(iso);
    if (isNaN(t)) return false;
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var d = (typeof days === 'number' && days >= 1) ? days : DEFAULT_RETENTION;
    return (now - t) > d * 24 * 60 * 60 * 1000;
  }

  function callStatus(c) {
    var dur = (c && typeof c.durationSec === 'number') ? c.durationSec : 0;
    if (dur > 0) return 'completed';
    if (c && c.endedAt) return 'missed'; // ended with no talk time
    return 'missed';
  }

  // Pure client-side history filter. filters: { agentId, from, to, status }
  // from/to: 'YYYY-MM-DD' date strings (inclusive). Missing fields = no filter.
  function filterHistory(calls, filters) {
    if (!Array.isArray(calls)) return [];
    filters = filters || {};
    var agentId = filters.agentId == null || filters.agentId === '' ? 'any' : String(filters.agentId);
    var status = String(filters.status || 'any').toLowerCase();
    var fromT = filters.from ? Date.parse(String(filters.from) + 'T00:00:00') : NaN;
    var toT = filters.to ? Date.parse(String(filters.to) + 'T23:59:59') : NaN;
    return calls.filter(function (c) {
      if (!c || typeof c !== 'object') return false;
      if (agentId !== 'any' && String(c.agentId) !== agentId) return false;
      if (status === 'completed' || status === 'missed') {
        if (callStatus(c) !== status) return false;
      }
      if (!isNaN(fromT) || !isNaN(toT)) {
        var t = Date.parse(c.startedAt);
        if (isNaN(t)) return false;
        if (!isNaN(fromT) && t < fromT) return false;
        if (!isNaN(toT) && t > toT) return false;
      }
      return true;
    });
  }

  var Hygiene = {
    ACCENTS: ACCENTS,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    DEFAULT_RETENTION: DEFAULT_RETENTION,
    sanitizeAccent: sanitizeAccent,
    accentSoft: accentSoft,
    applyAccent: applyAccent,
    initAccent: initAccent,
    getRetentionDays: getRetentionDays,
    setRetentionDays: setRetentionDays,
    isOlderThan: isOlderThan,
    callStatus: callStatus,
    filterHistory: filterHistory
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Hygiene;
  global.Hygiene = Hygiene;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
