'use strict';
/**
 * public/callx.js — WS5 "Call Experience" for Symbiote Calling v7.0.0.
 *
 * window.CallX — clean sub-modules with init hooks. This file NEVER touches
 * app.js state directly; the integrator wires every hook listed below.
 * Clean-room code. No secrets, no assets. DOM parts are browser-only and
 * guarded so the module still loads under Node for tests.
 *
 * ==========================================================================
 * CONTRACT FOR INTEGRATOR
 * ==========================================================================
 * 1. index.html — add BEFORE app.js (order matters: CallX must exist first):
 *      <link rel="stylesheet" href="callx.css">
 *      <script src="callx.js"></script>
 *
 * 2. app.js — recommended insertion points (exact hooks):
 *      a) In startCall(), right after `$('callOverlay').classList.remove('hidden')`
 *         and overlay aria update:
 *           CallX.notes.attach();            // in-call notes field
 *           CallX.notes.clear();
 *           CallX.bubble.attach();           // floating-bubble infra (hidden until used)
 *           CallX.meter.attach();            // connection-meter pill
 *           CallX.search.setSource(function () { return callTranscript; });
 *           CallX.quota.reset();             // quota per-call state
 *           // if a quota limit is configured: CallX.quota.setLimit(minutes)
 *      b) In startCall()'s worklet onmessage, next to the existing
 *         `$('pMeter').style.width = ...` line:
 *           CallX.meter.micLevel(e.data.level);
 *      c) On ws.onopen AND ws.onclose (and optionally in onServer 'error'):
 *           CallX.meter.netState(navigator.onLine, ws.readyState);
 *      d) In the 1s timer tick (setup_complete's setInterval), where
 *         fmtTimer() is rendered:
 *           CallX.quota.check(Math.floor((Date.now() - connectedAt) / 1000));
 *      e) In teardown() (and/or endCallUI()), BEFORE the overlay is hidden:
 *           CallX.notes.save(callId, keyHashHex).then(...); // fire-and-forget OK
 *           CallX.bubble.expand();           // restore overlay if minimized
 *           // NOTE: keyHashHex must be sha256(apiKey) as hex — compute via
 *           // CallX.keyHash(apiKey) (crypto.subtle, async) or pass null.
 *           // If server call records carry no keyHash, keyHash is ignored.
 *      f) Minimize/expand UI: wire a small button in the overlay (e.g. next
 *         to #pMute) to CallX.bubble.minimize() / the bubble's expand button
 *         calls CallX.bubble.expand() itself.
 *      g) Dialer recents: in the dialer view, call
 *           CallX.renderRecents(document.getElementById('<recents container>'),
 *                               function (entry) { startCall({ number: entry.number, agentId: entry.agentId }); });
 *         after every completed call add:
 *           CallX.recents.push({ name: callAgent.name, number: callAgent.number, agentId: callAgent.id });
 *      h) Dashboard: CallX.renderDashboardRecents(container, historyCalls, onDial)
 *         where historyCalls comes from GET /api/history (newest first inside).
 *      i) Notes route (server side): mount src/apiv7_callx.js in server.js
 *         handlePost(), before the final 404:
 *           var m = callxApi.NOTES_ROUTE.exec(p);
 *           if (m) {
 *             callxApi.handleNotes(m[1], body, { history: history, memory: memory })
 *               .then(function (r) { sendJson(res, r.status, r.body); })
 *               .catch(function () { sendJson(res, 500, { error: 'server error' }); });
 *             return;
 *           }
 *         with `var callxApi = require('./src/apiv7_callx');` at the top.
 *         ctx = { history: <CALLER'S per-keyHash CallHistory instance>,
 *                 memory: memory (optional) }.
 *         (store.js is v7 key-partitioned: pass the keyHash-scoped instance
 *         so notes land in calls_<keyHash>.json, not the legacy shared file.)
 *      j) Transcript download button (e.g. in history detail view):
 *           CallX.downloadTranscript(call.id, { lines: m.transcript, agentName: m.agentName });
 *
 * 3. CSS: callx.css is standalone; it uses the existing --acc/--ink/--line
 *    theme vars so light/dark follow the app theme automatically.
 * ==========================================================================
 */

var CallX = {};

(function () {
  var hasDOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  var storage = null;
  try { if (typeof localStorage !== 'undefined') storage = localStorage; } catch (e) { storage = null; }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  /* ------------------------------------------------------------------ *
   * 1. In-call notes                                                    *
   * ------------------------------------------------------------------ */
  var _notesText = '';
  var notes = {
    /** Browser-only: insert the notes field into the call overlay.
     *  container (optional): parent element; defaults to #callOverlay,
     *  inserted before #keypadSheet so it sits with the other sheets. */
    attach: function (container) {
      if (!hasDOM) return null;
      if (document.getElementById('callxNotesWrap')) return document.getElementById('callxNotesWrap');
      var host = container || document.getElementById('callOverlay');
      if (!host) return null;
      var wrap = el('details', 'callx-notes');
      wrap.id = 'callxNotesWrap';
      var sum = el('summary', 'callx-notes-sum', 'In-call notes');
      var ta = document.createElement('textarea');
      ta.id = 'callxNotes';
      ta.className = 'callx-notes-ta';
      ta.rows = 3;
      ta.placeholder = 'Jot notes during the call — saved with the call on hangup…';
      ta.value = _notesText;
      ta.addEventListener('input', function () { _notesText = ta.value; });
      wrap.appendChild(sum);
      wrap.appendChild(ta);
      var anchor = host.querySelector('#keypadSheet');
      if (anchor) host.insertBefore(wrap, anchor); else host.appendChild(wrap);
      return wrap;
    },
    get: function () {
      if (hasDOM) {
        var ta = document.getElementById('callxNotes');
        if (ta) return ta.value;
      }
      return _notesText;
    },
    set: function (v) {
      _notesText = String(v === undefined || v === null ? '' : v);
      if (hasDOM) {
        var ta = document.getElementById('callxNotes');
        if (ta) ta.value = _notesText;
      }
    },
    clear: function () { notes.set(''); },
    /** Save notes to the server call record. Fire-and-forget is fine.
     *  keyHash: sha256 hex of the API key (via CallX.keyHash) or null.
     *  Browser-only (uses fetch). Resolves true on 2xx, false otherwise. */
    save: function (callId, keyHash) {
      var text = notes.get();
      if (!text || !text.trim() || !callId) return Promise.resolve(false);
      if (!hasDOM || typeof fetch === 'undefined') return Promise.resolve(false);
      return fetch('/api/v7/calls/' + encodeURIComponent(callId) + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyHash: keyHash || null, notes: text })
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    }
  };

  /* ------------------------------------------------------------------ *
   * 2. Transcript download (text)                                       *
   * ------------------------------------------------------------------ */
  /** Build the plain-text transcript. lines: [{who, text}].
   *  Line format: "Caller: ..." / "<agentName>: ...". */
  function buildTranscriptText(lines, agentName) {
    var out = [];
    var aName = agentName || 'Agent';
    out.push('Symbiote Calling — call transcript');
    out.push('Generated: ' + new Date().toISOString());
    out.push('');
    (lines || []).forEach(function (t) {
      var who = (t.who === 'user') ? 'Caller' : aName;
      out.push(who + ': ' + String(t.text || ''));
    });
    return out.join('\n');
  }
  /** Browser-only: trigger a .txt download of the transcript.
   *  opts: { lines, agentName, source } — lines win; else search source. */
  function downloadTranscript(callId, opts) {
    if (!hasDOM) return false;
    opts = opts || {};
    var lines = opts.lines;
    if (!lines && search._getSource) { try { lines = search._getSource(); } catch (e) { lines = []; } }
    var text = buildTranscriptText(lines || [], opts.agentName);
    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = (window.URL || window.webkitURL).createObjectURL(blob);
    a.download = 'call-' + String(callId || 'transcript').replace(/[^A-Za-z0-9_-]/g, '_') + '.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { (window.URL || window.webkitURL).revokeObjectURL(a.href); } catch (e) {}
      a.remove();
    }, 4000);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 3. Transcript search                                                *
   * ------------------------------------------------------------------ */
  /** Pure: case-insensitive substring search over [{who, text}].
   *  Returns [{index, who, text}] for matching lines, in order.
   *  Empty/blank query or bad input -> []. */
  function searchLines(lines, q) {
    var query = String(q === undefined || q === null ? '' : q).trim().toLowerCase();
    if (!query || !Array.isArray(lines)) return [];
    var hits = [];
    for (var i = 0; i < lines.length; i++) {
      var t = String((lines[i] && lines[i].text) || '');
      if (t.toLowerCase().indexOf(query) !== -1) {
        hits.push({ index: i, who: lines[i] ? lines[i].who : '', text: t });
      }
    }
    return hits;
  }
  var search = {
    _getSource: null,
    /** Wire the live transcript: CallX.search.setSource(function(){return callTranscript;}) */
    setSource: function (fn) { search._getSource = fn; },
    query: function (q) {
      var lines = [];
      if (search._getSource) { try { lines = search._getSource() || []; } catch (e) { lines = []; } }
      return searchLines(lines, q);
    },
    /** Browser-only: highlight matches inside a chat-log container.
     *  Safe: originals stored in data-callx-orig and restored on next call. */
    highlight: function (container, q) {
      if (!hasDOM || !container) return 0;
      var query = String(q === undefined || q === null ? '' : q).trim();
      var bubbles = container.querySelectorAll('.cbub');
      var count = 0;
      for (var i = 0; i < bubbles.length; i++) {
        var b = bubbles[i];
        if (b.getAttribute('data-callx-orig') === null) b.setAttribute('data-callx-orig', b.textContent);
        var orig = b.getAttribute('data-callx-orig');
        if (!query) { b.textContent = orig; continue; }
        var low = orig.toLowerCase(), ql = query.toLowerCase(), pos = low.indexOf(ql);
        if (pos === -1) { b.textContent = orig; continue; }
        b.textContent = '';
        b.appendChild(document.createTextNode(orig.slice(0, pos)));
        var mark = document.createElement('mark');
        mark.className = 'callx-mark';
        mark.textContent = orig.slice(pos, pos + query.length);
        b.appendChild(mark);
        b.appendChild(document.createTextNode(orig.slice(pos + query.length)));
        count++;
      }
      return count;
    }
  };

  /* ------------------------------------------------------------------ *
   * 4. Floating call bubble                                             *
   * ------------------------------------------------------------------ */
  var bubble = {
    _overlay: null,
    _btn: null,
    _drag: null,
    /** Browser-only: find #callOverlay, create the expand pill (hidden). */
    attach: function () {
      if (!hasDOM) return null;
      bubble._overlay = document.getElementById('callOverlay');
      if (!bubble._overlay) return null;
      if (!bubble._btn) {
        var b = el('button', 'callx-expand hidden', 'Expand call');
        b.id = 'callxExpand';
        b.type = 'button';
        b.setAttribute('aria-label', 'Expand call');
        b.addEventListener('click', function () { bubble.expand(); });
        document.body.appendChild(b);
        bubble._btn = b;
      }
      return bubble._btn;
    },
    /** Browser-only: collapse overlay to a small draggable bubble.
     *  Audio keeps running — this only restyles/hides DOM. */
    minimize: function () {
      if (!hasDOM) return false;
      var ov = bubble._overlay || document.getElementById('callOverlay');
      if (!ov) return false;
      bubble._overlay = ov;
      bubble.attach();
      ov.classList.add('callx-minimized');
      if (bubble._btn) bubble._btn.classList.remove('hidden');
      // Drag: pointer events on the minimized overlay.
      ov.onpointerdown = function (e) {
        if (!ov.classList.contains('callx-minimized')) return;
        bubble._drag = { x: e.clientX - ov.offsetLeft, y: e.clientY - ov.offsetTop };
        ov.setPointerCapture && ov.setPointerCapture(e.pointerId);
      };
      ov.onpointermove = function (e) {
        if (!bubble._drag) return;
        ov.style.left = (e.clientX - bubble._drag.x) + 'px';
        ov.style.top = (e.clientY - bubble._drag.y) + 'px';
        ov.style.right = 'auto';
        ov.style.bottom = 'auto';
      };
      ov.onpointerup = function () { bubble._drag = null; };
      return true;
    },
    /** Browser-only: restore the full overlay. */
    expand: function () {
      if (!hasDOM) return false;
      var ov = bubble._overlay || document.getElementById('callOverlay');
      if (!ov) return false;
      ov.classList.remove('callx-minimized');
      ov.style.left = ''; ov.style.top = ''; ov.style.right = ''; ov.style.bottom = '';
      ov.onpointerdown = null; ov.onpointermove = null; ov.onpointerup = null;
      if (bubble._btn) bubble._btn.classList.add('hidden');
      return true;
    },
    isMinimized: function () {
      if (!hasDOM) return false;
      var ov = bubble._overlay || document.getElementById('callOverlay');
      return !!(ov && ov.classList.contains('callx-minimized'));
    }
  };

  /* ------------------------------------------------------------------ *
   * 5. Connection meter                                                 *
   * ------------------------------------------------------------------ */
  /** Pure net-status classifier. online: navigator.onLine, ready: ws.readyState.
   *  Returns 'live' | 'connecting' | 'offline'. */
  function netStatus(online, ready) {
    if (!online) return 'offline';
    return ready === 1 ? 'live' : 'connecting';
  }
  var meter = {
    _pill: null,
    /** Browser-only: create the pill inside #callOverlay. */
    attach: function () {
      if (!hasDOM) return null;
      if (meter._pill) return meter._pill;
      var host = document.getElementById('callOverlay');
      if (!host) return null;
      var pill = el('div', 'callx-meter');
      pill.id = 'callxMeter';
      pill.innerHTML = '<span class="callx-meter-dot" id="callxMeterDot"></span>' +
        '<span class="callx-meter-label" id="callxMeterLabel">…</span>' +
        '<span class="callx-meter-bar"><span id="callxMeterBar"></span></span>';
      host.appendChild(pill);
      meter._pill = pill;
      return pill;
    },
    /** Feed mic level 0..~1 (same values app.js writes to #pMeter). Browser-only. */
    micLevel: function (v) {
      if (!hasDOM) return;
      meter.attach();
      var bar = document.getElementById('callxMeterBar');
      if (bar) bar.style.width = Math.max(0, Math.min(100, Math.round(Number(v || 0) * 400))) + '%';
    },
    /** online: navigator.onLine, wsReady: ws.readyState. Returns status string. */
    netState: function (online, wsReady) {
      var s = netStatus(online, wsReady);
      if (!hasDOM) return s;
      meter.attach();
      var dot = document.getElementById('callxMeterDot');
      var label = document.getElementById('callxMeterLabel');
      if (dot) dot.className = 'callx-meter-dot ' + s;
      if (label) label.textContent = s === 'live' ? 'Connected' : (s === 'offline' ? 'Offline' : 'Connecting…');
      return s;
    }
  };

  /* ------------------------------------------------------------------ *
   * 6. Quota timer alerts                                               *
   * ------------------------------------------------------------------ */
  function beep() {
    // Own tiny oscillator — no assets. Browser-only.
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g); g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.4);
      o.onended = function () { try { ctx.close(); } catch (e) {} };
    } catch (e) { /* audio unavailable — visual alert still applies */ }
  }
  var quota = {
    _limitSec: 0,
    _fired: false,
    /** Set the per-call budget in minutes. 0/negative disables. Resets fired state. */
    setLimit: function (minutes) {
      var m = Number(minutes);
      quota._limitSec = (isNaN(m) || m <= 0) ? 0 : Math.floor(m * 60);
      quota._fired = false;
    },
    reset: function () { quota._fired = false; },
    /** Call from the 1s timer tick with elapsed seconds.
     *  Returns true ONLY on the tick that crosses the limit (fires once). */
    check: function (elapsedSec) {
      if (quota._limitSec <= 0 || quota._fired) return false;
      if (Number(elapsedSec) >= quota._limitSec) {
        quota._fired = true;
        if (hasDOM) {
          var t = document.getElementById('pState');
          if (t) t.classList.add('callx-over');
          beep();
        }
        return true;
      }
      return false;
    },
    isFired: function () { return quota._fired; }
  };

  /* ------------------------------------------------------------------ *
   * 7. Dialer recents                                                   *
   * ------------------------------------------------------------------ */
  var RECENTS_KEY = 'callx_recents_v1';
  var RECENTS_CAP = 20;
  var recents = {
    _store: null, // test seam: inject a localStorage-like object
    _s: function () { return recents._store || storage; },
    _read: function () {
      var s = recents._s();
      if (!s) return [];
      try {
        var arr = JSON.parse(s.getItem(RECENTS_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    },
    _write: function (arr) {
      var s = recents._s();
      if (!s) return;
      try { s.setItem(RECENTS_KEY, JSON.stringify(arr)); } catch (e) {}
    },
    /** push({name, number, agentId}) — most-recent first, dedup by number,
     *  favorites preserved across re-dials. Returns the stored entry. */
    push: function (entry) {
      entry = entry || {};
      var number = String(entry.number || '').trim();
      if (!number) return null;
      var arr = recents._read();
      var fav = false, old = null;
      arr = arr.filter(function (e) {
        if (String(e.number) === number) { fav = !!e.fav; old = e; return false; }
        return true;
      });
      var rec = {
        name: entry.name || (old && old.name) || number,
        number: number,
        agentId: entry.agentId || (old && old.agentId) || null,
        fav: fav,
        lastCalled: new Date().toISOString()
      };
      arr.unshift(rec);
      recents._write(arr.slice(0, RECENTS_CAP));
      return rec;
    },
    list: function () { return recents._read(); },
    favorites: function () { return recents._read().filter(function (e) { return e.fav; }); },
    /** Toggle favorite for a number. Returns the new fav state (false if unknown). */
    toggleFav: function (number) {
      var n = String(number || '');
      var arr = recents._read(), found = false, state = false;
      arr.forEach(function (e) {
        if (String(e.number) === n) { e.fav = !e.fav; state = e.fav; found = true; }
      });
      if (found) recents._write(arr);
      return state;
    },
    remove: function (number) {
      var n = String(number || '');
      recents._write(recents._read().filter(function (e) { return String(e.number) !== n; }));
    },
    clear: function () { recents._write([]); },
    /** Browser-only: render recents + favorites into container.
     *  onDial(entry) is called on tap-to-dial. */
    render: function (container, onDial) {
      if (!hasDOM || !container) return;
      var arr = recents._read();
      container.innerHTML = '';
      if (!arr.length) {
        container.appendChild(el('p', 'dim tiny', 'No recent calls yet.'));
        return;
      }
      var favs = arr.filter(function (e) { return e.fav; });
      var rest = arr.filter(function (e) { return !e.fav; });
      function row(e) {
        var r = el('button', 'callx-recent', null);
        r.type = 'button';
        var star = el('span', 'callx-star' + (e.fav ? ' on' : ''), e.fav ? '★' : '☆');
        star.setAttribute('role', 'button');
        star.setAttribute('aria-label', 'toggle favorite');
        star.addEventListener('click', function (ev) {
          ev.stopPropagation();
          recents.toggleFav(e.number);
          recents.render(container, onDial);
        });
        var mid = el('span', 'callx-recent-mid');
        mid.appendChild(el('span', 'callx-recent-name', e.name || e.number));
        mid.appendChild(el('span', 'callx-recent-num mono dim', e.number));
        var go = el('span', 'callx-recent-go', '↩');
        r.appendChild(star); r.appendChild(mid); r.appendChild(go);
        r.addEventListener('click', function () { if (onDial) onDial(e); });
        return r;
      }
      if (favs.length) {
        container.appendChild(el('div', 'callx-recent-head', 'Favorites'));
        favs.forEach(function (e) { container.appendChild(row(e)); });
      }
      if (rest.length) {
        container.appendChild(el('div', 'callx-recent-head', 'Recent'));
        rest.forEach(function (e) { container.appendChild(row(e)); });
      }
    }
  };
  /** Standalone helper kept for the integrator: CallX.renderRecents(el, fn). */
  function renderRecents(container, onDial) { recents.render(container, onDial); }

  /* ------------------------------------------------------------------ *
   * 8. Dashboard recents (one-tap redial, last 8 calls)                 *
   * ------------------------------------------------------------------ */
  /** Browser-only. calls: array from GET /api/history. onDial(call). */
  function renderDashboardRecents(container, calls, onDial) {
    if (!hasDOM || !container) return;
    var arr = (Array.isArray(calls) ? calls.slice() : []).sort(function (a, b) {
      return Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0);
    }).slice(0, 8);
    container.innerHTML = '';
    if (!arr.length) {
      container.appendChild(el('p', 'dim tiny', 'No calls yet.'));
      return;
    }
    arr.forEach(function (c) {
      var r = el('button', 'callx-recent', null);
      r.type = 'button';
      var mid = el('span', 'callx-recent-mid');
      mid.appendChild(el('span', 'callx-recent-name', c.agentName || 'Unknown'));
      var sub = (c.number || '') +
        (c.durationSec !== undefined && c.durationSec !== null ? ' · ' + c.durationSec + 's' : '') +
        (c.summary ? ' · summarized' : '');
      mid.appendChild(el('span', 'callx-recent-num mono dim', sub));
      var go = el('span', 'callx-recent-go', '↩');
      r.appendChild(mid); r.appendChild(go);
      r.addEventListener('click', function () { if (onDial) onDial(c); });
      container.appendChild(r);
    });
  }

  /* ------------------------------------------------------------------ *
   * Misc helpers                                                        *
   * ------------------------------------------------------------------ */
  /** sha256 hex of a string (for the keyHash the notes API accepts).
   *  Async, browser-only (crypto.subtle). Resolves null when unavailable. */
  function keyHash(apiKey) {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(apiKey || '')))
          .then(function (buf) {
            var bytes = new Uint8Array(buf), hex = '';
            for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
            return hex;
          }).catch(function () { return null; });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }

  CallX.version = '7.0.0-ws5';
  CallX.notes = notes;
  CallX.buildTranscriptText = buildTranscriptText;
  CallX.downloadTranscript = downloadTranscript;
  CallX.searchLines = searchLines;
  CallX.search = search;
  CallX.bubble = bubble;
  CallX.netStatus = netStatus;
  CallX.meter = meter;
  CallX.quota = quota;
  CallX.recents = recents;
  CallX.renderRecents = renderRecents;
  CallX.renderDashboardRecents = renderDashboardRecents;
  CallX.keyHash = keyHash;
})();

if (typeof window !== 'undefined') window.CallX = CallX;
if (typeof module !== 'undefined' && module.exports) module.exports = CallX;
