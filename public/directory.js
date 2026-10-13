'use strict';
/* public/directory.js — v7.0.0 WS4 "Directory UX" (+ v8.0.0 W4: #39 pinned
 * favorites, #40 smart home greeting).
 *
 * window.Directory: searchable/filterable agent directory with profile sheets
 * and swipe gestures. Pure logic is exported for node tests; DOM work runs
 * only in the browser.
 *
 * ================= INTEGRATOR CONTRACT =================
 * 1. index.html additions (order matters: avatar.js already loads globally):
 *      <link rel="stylesheet" href="directory.css">
 *      <script src="directory.js"></script>
 * 2. Replace/augment app.js renderAgents wiring. Suggested pattern in app.js:
 *      // keep loadAgents() filling AGENTS as-is
 *      $('agentSearch').addEventListener('input', function (e) {
 *        Directory.renderDirectory($('agentGrid'), AGENTS, { initialQ: e.target.value });
 *      });
 *    Or call Directory.renderDirectory once with the full AGENTS list and let
 *    it own the search input it renders above the grid.
 * 3. Gesture contract (pass via renderDirectory opts):
 *      onCall(agent)     — swipe RIGHT or "Call" button → app.js startCall({ agentId: agent.id })
 *      onProfile(agent)  — card tap / swipe LEFT → Directory.profileSheet(agent, stats)
 * 4. Per-agent stats source: compute client-side from GET /api/history.
 *    history rows are { agentId, startedAt, durationSec, outcome, ... }.
 *    Suggested aggregation (also exposed as Directory.computeStatsFromHistory):
 *      function apiFetch(u) { return window.KeyGate ? window.KeyGate.apiFetch(u) : fetch(u); }
 *      var history = await (await apiFetch('api/history')).json();
 *      var stats = Directory.computeStatsFromHistory(history.calls || history || [], agentId);
 *      // => { calls, minutes, lastOutcome }
 *    Pass `stats` into Directory.profileSheet(agent, stats). Renderers accept
 *    stats via opts.stats = { agentId: { calls, minutes, lastOutcome } }.
 * 5. Clone button in the sheet calls window.CustomAgents.cloneFrom(agent) only
 *    if present (built by the sibling custom-agents workstream); otherwise the
 *    button is hidden — never an error.
 * =========================================================
 */
(function (global) {

  /* ---------- pure logic (node-testable) ---------- */

  // filterAgents(agents, {q, gender, role})
  // q: case-insensitive match across name/number/niche/role (substring).
  // gender: 'any' | 'male' | 'female' — exact match on agent.gender.
  // role: 'any' or free-text substring against agent.role (falls back to niche
  //   when the agent has no role field).
  function filterAgents(agents, opts) {
    if (!Array.isArray(agents)) return [];
    opts = opts || {};
    var q = String(opts.q == null ? '' : opts.q).trim().toLowerCase();
    var gender = String(opts.gender || 'any').toLowerCase();
    var role = String(opts.role == null ? 'any' : opts.role).trim().toLowerCase();
    return agents.filter(function (a) {
      if (!a) return false;
      if (q) {
        var hay = String(a.name || '') + ' ' + String(a.number || '') + ' ' +
                  String(a.niche || '') + ' ' + String(a.role || '');
        if (hay.toLowerCase().indexOf(q) === -1) return false;
      }
      if (gender === 'male' || gender === 'female') {
        if (String(a.gender || '').toLowerCase() !== gender) return false;
      }
      if (role && role !== 'any') {
        var field = String(a.role || a.niche || '');
        if (field.toLowerCase().indexOf(role) === -1) return false;
      }
      return true;
    });
  }

  // extractSwipeAction(dx, dy) — decide the swipe gesture from a drag delta.
  // Threshold ~60px and must be mostly horizontal; returns 'right' | 'left' | null.
  // DOM wiring (touch/mouse listeners) lives in attachSwipe and is browser-only.
  var SWIPE_MIN_PX = 60;
  function extractSwipeAction(dx, dy) {
    dx = Number(dx) || 0;
    dy = Number(dy) || 0;
    if (Math.abs(dx) < SWIPE_MIN_PX) return null;
    if (Math.abs(dy) > Math.abs(dx)) return null; // mostly vertical — not a swipe
    return dx > 0 ? 'right' : 'left';
  }

  // computeStatsFromHistory(calls, agentId) — aggregate per-agent stats from
  // the GET /api/history list: { calls, minutes, lastOutcome }.
  function computeStatsFromHistory(calls, agentId) {
    var rows = (Array.isArray(calls) ? calls : []).filter(function (c) {
      return c && (c.agentId === agentId);
    });
    var secs = rows.reduce(function (t, c) { return t + (Number(c.durationSec) || 0); }, 0);
    var last = rows.length ? rows[rows.length - 1] : null;
    return {
      calls: rows.length,
      minutes: Math.round(secs / 60),
      lastOutcome: last ? (last.outcome || last.status || '—') : '—'
    };
  }

  /* ---------- v8.0.0 W4: pinned favorites (#39) + smart greeting (#40) ----------
   * Pure, node-testable helpers. Browser storage lives further down. */

  // greetingForHour(h) — 0..23 -> time-of-day greeting label.
  function greetingForHour(h) {
    h = Number(h);
    if (!isFinite(h)) return 'Good evening';
    h = ((Math.floor(h) % 24) + 24) % 24;
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  // Pinned-favorite storage: one localStorage partition per API key so one
  // key's pins never leak into another key's view (same isolation model as
  // dialer recents in callx.js).
  var PINS_LS_PREFIX = 'sym-v8-pins_';
  function pinsStorageKey(keyHash) {
    return PINS_LS_PREFIX + (keyHash ? String(keyHash) : 'shared');
  }
  // normalizePinList(v) -> array of unique non-empty id strings, order kept.
  function normalizePinList(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (x) {
      var s = String(x == null ? '' : x).trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }
  // toggleInList(list, id) -> { list, pinned } (pure; does not mutate input).
  function toggleInList(list, id) {
    var l = normalizePinList(list);
    var s = String(id == null ? '' : id);
    var i = l.indexOf(s);
    if (i === -1) { l.push(s); return { list: l, pinned: true }; }
    l.splice(i, 1);
    return { list: l, pinned: false };
  }
  // agentKey(a) — stable identity used for pins (falls back to number/name).
  function agentKey(a) {
    if (!a) return '';
    return String(a.id || a.number || a.name || '');
  }

  // suggestAgents(recents, agents, statsTop, n) — rank suggested agents.
  // recents: dialer recents [{agentId,...}] most-recent-first (per-key scoped
  //   by CallX.recents). statsTop: /api/stats topAgents [{agentId}].
  // Both signals are recency/frequency weighted; returns up to n agent objects.
  function suggestAgents(recents, agents, statsTop, n) {
    n = Math.max(1, Number(n) || 3);
    var counts = {};
    (Array.isArray(recents) ? recents : []).forEach(function (r, i) {
      var id = r && (r.agentId || r.id);
      if (!id) return;
      id = String(id);
      counts[id] = (counts[id] || 0) + (20 - Math.min(i, 19));
    });
    (Array.isArray(statsTop) ? statsTop : []).forEach(function (t, i) {
      var id = t && (t.agentId || t.id);
      if (!id) return;
      id = String(id);
      counts[id] = (counts[id] || 0) + ((5 - Math.min(i, 4)) * 3);
    });
    var byId = {};
    (Array.isArray(agents) ? agents : []).forEach(function (a) {
      var k = a && agentKey(a);
      if (k) byId[k] = a;
    });
    var ranked = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    var out = [];
    ranked.forEach(function (id) {
      if (byId[id] && out.length < n) out.push(byId[id]);
    });
    return out;
  }

  /* ---------- browser-only DOM helpers ---------- */

  function isBrowser() { return typeof document !== 'undefined'; }

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function avatarFor(agent) {
    if (global.avatarHTML) return global.avatarHTML(agent);
    return '<div class="dir-avatar-fallback">' +
      String((agent.name || '?').charAt(0)).toUpperCase() + '</div>';
  }

  function sfxTap() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      var o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
      o.type = 'sine'; o.frequency.value = 660;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.1);
    } catch (e) {}
  }

  /* ---------- swipe gestures ---------- */

  // attachSwipe(cardEl, { onSwipeRight, onSwipeLeft }) — touchstart/touchend
  // plus mouse drag for desktop testing. Decisions go through
  // extractSwipeAction; listeners ignore mostly-vertical drags.
  function attachSwipe(cardEl, handlers) {
    if (!isBrowser() || !cardEl) return function () {};
    handlers = handlers || {};
    var sx = 0, sy = 0, tracking = false;

    function begin(x, y) { sx = x; sy = y; tracking = true; }
    function end(x, y) {
      if (!tracking) return;
      tracking = false;
      var action = extractSwipeAction(x - sx, y - sy);
      if (action === 'right' && typeof handlers.onSwipeRight === 'function') handlers.onSwipeRight();
      else if (action === 'left' && typeof handlers.onSwipeLeft === 'function') handlers.onSwipeLeft();
    }
    function onTouchStart(e) {
      var t = e.touches[0];
      begin(t.clientX, t.clientY);
      cardEl.classList.add('swiping');
    }
    function onTouchEnd(e) {
      cardEl.classList.remove('swiping');
      var t = e.changedTouches[0];
      end(t.clientX, t.clientY);
    }
    function onMouseDown(e) {
      if (e.button !== 0) return;
      begin(e.clientX, e.clientY);
      cardEl.classList.add('swiping');
    }
    function onMouseUp(e) {
      cardEl.classList.remove('swiping');
      end(e.clientX, e.clientY);
    }
    function onMouseLeave() { cardEl.classList.remove('swiping'); tracking = false; }

    cardEl.addEventListener('touchstart', onTouchStart, { passive: true });
    cardEl.addEventListener('touchend', onTouchEnd);
    cardEl.addEventListener('mousedown', onMouseDown);
    cardEl.addEventListener('mouseup', onMouseUp);
    cardEl.addEventListener('mouseleave', onMouseLeave);

    return function detach() {
      cardEl.removeEventListener('touchstart', onTouchStart);
      cardEl.removeEventListener('touchend', onTouchEnd);
      cardEl.removeEventListener('mousedown', onMouseDown);
      cardEl.removeEventListener('mouseup', onMouseUp);
      cardEl.removeEventListener('mouseleave', onMouseLeave);
    };
  }

  /* ---------- profile sheet ---------- */

  var sheetRoot = null;
  function closeSheet() {
    if (sheetRoot && sheetRoot.parentNode) sheetRoot.parentNode.removeChild(sheetRoot);
    sheetRoot = null;
  }

  // profileSheet(agent, stats, callbacks)
  // Bottom-sheet modal: big avatar, name, number, role/niche, tone-voice line,
  // per-agent stats, Call / (Clone) / Close buttons.
  // stats = { calls, minutes, lastOutcome } — pass Directory.computeStatsFromHistory(...) output.
  // callbacks = { onCall(agent) } — optional; defaults to nothing.
  function profileSheet(agent, stats, callbacks) {
    if (!isBrowser() || !agent) return null;
    closeSheet();
    callbacks = callbacks || {};
    stats = stats || { calls: 0, minutes: 0, lastOutcome: '—' };

    sheetRoot = el('div', 'dir-sheet-veil');
    var sheet = el('div', 'dir-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Agent profile');

    var head = el('div', 'dir-sheet-head');
    var av = el('div', 'avatar dir-sheet-avatar');
    av.innerHTML = avatarFor(agent);
    head.appendChild(av);
    var info = el('div', 'dir-sheet-info');
    info.appendChild(el('div', 'dir-sheet-name', agent.name || 'Agent'));
    info.appendChild(el('div', 'dir-sheet-niche', agent.niche || ''));
    info.appendChild(el('div', 'dir-sheet-num mono', agent.number || ''));
    head.appendChild(info);
    sheet.appendChild(head);

    var meta = el('div', 'dir-sheet-meta');
    var roleLine = el('div', 'dir-sheet-line',
      'Role: ' + (agent.role || agent.niche || '—'));
    var voiceLine = el('div', 'dir-sheet-line dim',
      'Voice: ' + (agent.voice || '—') + ' · Tone: ' + (agent.tone || agent.gender || '—'));
    meta.appendChild(roleLine);
    meta.appendChild(voiceLine);
    if (agent.tagline) meta.appendChild(el('div', 'dir-sheet-line dim', agent.tagline));
    sheet.appendChild(meta);

    var statsRow = el('div', 'dir-sheet-stats');
    [['calls', stats.calls, 'Calls'],
     ['mins', stats.minutes, 'Minutes'],
     ['last', stats.lastOutcome, 'Last outcome']].forEach(function (s) {
      var c = el('div', 'dir-sheet-stat');
      c.appendChild(el('div', 'dir-sheet-stat-num', String(s[1] == null ? 0 : s[1])));
      c.appendChild(el('div', 'dir-sheet-stat-lbl', s[2]));
      statsRow.appendChild(c);
    });
    sheet.appendChild(statsRow);

    var actions = el('div', 'dir-sheet-actions');
    var callBtn = el('button', 'btn primary dir-sheet-call', 'Call');
    callBtn.type = 'button';
    callBtn.onclick = function () {
      sfxTap();
      closeSheet();
      if (typeof callbacks.onCall === 'function') callbacks.onCall(agent);
    };
    actions.appendChild(callBtn);

    // Clone is optional — the sibling custom-agents workstream provides
    // window.CustomAgents.cloneFrom(agent); hide when absent, and always
    // hide for custom agents (custom agents are not cloneable).
    if (!agent.isCustom && global.CustomAgents && typeof global.CustomAgents.cloneFrom === 'function') {
      var cloneBtn = el('button', 'btn ghost dir-sheet-clone', 'Clone');
      cloneBtn.type = 'button';
      cloneBtn.onclick = function () {
        sfxTap();
        closeSheet();
        global.CustomAgents.cloneFrom(agent);
      };
      actions.appendChild(cloneBtn);
    }

    var closeBtn = el('button', 'btn ghost dir-sheet-close', 'Close');
    closeBtn.type = 'button';
    closeBtn.onclick = function () { sfxTap(); closeSheet(); };
    actions.appendChild(closeBtn);
    sheet.appendChild(actions);

    sheetRoot.appendChild(sheet);
    sheetRoot.addEventListener('click', function (e) {
      if (e.target === sheetRoot) closeSheet();
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closeSheet(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(sheetRoot);
    requestAnimationFrame(function () { sheetRoot.classList.add('open'); });
    return sheetRoot;
  }

  /* ---------- directory rendering ---------- */

  var filters = { q: '', gender: 'any', role: 'any' };
  var lastAgents = [];
  var lastOpts = {};
  var lastContainer = null; // v8: rerender target for pin toggles

  /* ---------- v8 pins: browser storage (per API key) ---------- */
  var pins = { keyHash: null, ids: [] };
  function currentKeyHashSync() {
    try {
      if (global.KeyGate && global.KeyGate._keyHash) return String(global.KeyGate._keyHash);
    } catch (e) {}
    return null;
  }
  function loadPinIds(keyHash) {
    if (!isBrowser()) return [];
    try {
      var raw = localStorage.getItem(pinsStorageKey(keyHash));
      return normalizePinList(raw ? JSON.parse(raw) : []);
    } catch (e) { return []; }
  }
  function savePins() {
    if (!isBrowser()) return;
    try { localStorage.setItem(pinsStorageKey(pins.keyHash), JSON.stringify(pins.ids)); }
    catch (e) {}
  }
  function isPinned(id) { return pins.ids.indexOf(String(id == null ? '' : id)) !== -1; }
  // resolvePinsKeyHash(cb) — async: prefer KeyGate.getKeyHash(), fall back to
  // the sync _keyHash. Re-renders the grid when the partition changes.
  function resolvePinsKeyHash(cb) {
    if (!isBrowser()) { if (cb) cb(pins.ids); return; }
    function done(kh) {
      if (kh && kh !== pins.keyHash) { pins.keyHash = kh; pins.ids = loadPinIds(kh); }
      if (typeof cb === 'function') cb(pins.ids);
    }
    try {
      if (global.KeyGate && typeof global.KeyGate.getKeyHash === 'function') {
        global.KeyGate.getKeyHash().then(done).catch(function () { done(currentKeyHashSync()); });
        return;
      }
    } catch (e) {}
    done(currentKeyHashSync());
  }

  var PIN_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>';

  /* ---------- v8: smart greeting banner (#40) ---------- */
  function apiFetchLocal(u) {
    try {
      if (global.KeyGate && typeof global.KeyGate.apiFetch === 'function') return global.KeyGate.apiFetch(u);
    } catch (e) {}
    return fetch(u);
  }
  function readDialerRecents() {
    try {
      if (global.CallX && global.CallX.recents && typeof global.CallX.recents.list === 'function')
        return global.CallX.recents.list();
    } catch (e) {}
    return [];
  }
  var cachedStatsTop = [];
  function buildGreetingBanner() {
    var b = el('div', 'dir-greet');
    var line = el('div', 'dir-greet-line');
    var h = new Date().getHours();
    line.appendChild(el('span', 'dir-greet-ico', '👋'));
    line.appendChild(el('span', 'dir-greet-text', greetingForHour(h) + ' — who should we call?'));
    b.appendChild(line);
    var chips = el('div', 'dir-greet-chips');
    chips.setAttribute('data-role', 'suggestions');
    b.appendChild(chips);
    return b;
  }
  function renderSuggestionChips() {
    if (!isBrowser() || !lastContainer) return;
    var box = lastContainer.querySelector('[data-role="suggestions"]');
    if (!box) return;
    var sug = suggestAgents(readDialerRecents(), lastAgents, cachedStatsTop, 3);
    box.innerHTML = '';
    if (!sug.length) {
      box.appendChild(el('span', 'dir-chip-empty tiny dim', 'Your most-called agents will appear here.'));
      return;
    }
    box.appendChild(el('span', 'dir-chip-lbl tiny dim', 'Suggested:'));
    sug.forEach(function (a) {
      var c = el('button', 'dir-chip', a.name || 'Agent');
      c.type = 'button';
      c.title = a.niche ? (a.niche + ' — tap to call') : 'Tap to call';
      c.onclick = function () {
        sfxTap();
        if (typeof lastOpts.onCall === 'function') lastOpts.onCall(a);
      };
      box.appendChild(c);
    });
  }
  function refreshSuggestions() {
    renderSuggestionChips();
    // Enhance with /api/stats most-called when available (best-effort).
    apiFetchLocal('api/stats').then(function (r) { return r.json(); }).then(function (j) {
      var s = j && j.stats;
      cachedStatsTop = (s && s.topAgents) || [];
      renderSuggestionChips();
    }).catch(function () {});
  }

  // Build one agent card using the same markup/classes as app.js renderAgents:
  // .acard > (.a-top > .avatar + (.a-name, .a-niche)) + .a-num.mono + .a-tag + .btn.call
  // v8: + a pin/unpin star button (top-right) feeding the "Pinned" row (#39).
  function buildCard(agent, opts) {
    var d = el('div', 'acard dir-card');
    if (agent.isCustom) d.classList.add('custom');
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-label', 'Profile of ' + (agent.name || 'agent'));

    var top = el('div', 'a-top');
    var av = el('div', 'avatar');
    av.innerHTML = avatarFor(agent);
    top.appendChild(av);
    var names = el('div');
    names.appendChild(el('div', 'a-name', agent.name || ''));
    names.appendChild(el('div', 'a-niche', agent.niche || ''));
    top.appendChild(names);
    d.appendChild(top);
    d.appendChild(el('div', 'a-num mono', agent.number || ''));
    d.appendChild(el('div', 'a-tag', agent.tagline || ''));
    var hint = el('div', 'dir-swipe-hint tiny dim', 'swipe → call · swipe ← profile');
    d.appendChild(hint);

    // v8 pin toggle — stopPropagation so the pin click never opens the sheet.
    var key = agentKey(agent);
    var pinBtn = el('button', 'dir-pin' + (isPinned(key) ? ' on' : ''));
    pinBtn.type = 'button';
    pinBtn.innerHTML = PIN_SVG;
    pinBtn.setAttribute('aria-label', (isPinned(key) ? 'Unpin ' : 'Pin ') + (agent.name || 'agent'));
    pinBtn.setAttribute('aria-pressed', isPinned(key) ? 'true' : 'false');
    pinBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      e.preventDefault();
      sfxTap();
      var r = toggleInList(pins.ids, key);
      pins.ids = r.list;
      savePins();
      if (lastContainer) rerenderGrid(lastContainer);
    });
    d.appendChild(pinBtn);

    d.addEventListener('click', function () {
      sfxTap();
      if (typeof opts.onProfile === 'function') opts.onProfile(agent);
    });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (typeof opts.onProfile === 'function') opts.onProfile(agent);
      }
    });
    attachSwipe(d, {
      onSwipeRight: function () { if (typeof opts.onCall === 'function') opts.onCall(agent); },
      onSwipeLeft: function () { if (typeof opts.onProfile === 'function') opts.onProfile(agent); }
    });
    return d;
  }

  function buildToolbar(container) {
    var bar = el('div', 'dir-toolbar');

    var searchWrap = el('div', 'dir-search-wrap');
    var search = el('input', 'dir-search');
    search.type = 'text';
    search.placeholder = 'Search name, number, niche…';
    search.setAttribute('aria-label', 'Search agents');
    search.value = filters.q;
    searchWrap.appendChild(search);
    bar.appendChild(searchWrap);

    search.addEventListener('input', function () {
      filters.q = search.value;
      rerenderGrid(container);
    });
    return bar;
  }

  function rerenderGrid(container) {
    var grid = container.querySelector('.dir-grid');
    if (!grid) return;
    var list = filterAgents(lastAgents, filters);
    // v8 #39: pinned agents (in pin order) lift into a "Pinned" row above
    // the main grid; they are excluded from the grid itself.
    var pinOrder = {};
    pins.ids.forEach(function (id, i) { pinOrder[id] = i; });
    var pinned = [], rest = [];
    list.forEach(function (a) {
      (pinOrder[agentKey(a)] != null ? pinned : rest).push(a);
    });
    pinned.sort(function (a, b) { return pinOrder[agentKey(a)] - pinOrder[agentKey(b)]; });

    var sec = container.querySelector('.dir-pinned-sec');
    if (sec && sec.parentNode) sec.parentNode.removeChild(sec);
    if (pinned.length) {
      sec = el('div', 'dir-pinned-sec');
      var head = el('div', 'dir-pinned-head');
      var star = el('span', 'dir-pinned-star');
      star.innerHTML = PIN_SVG;
      head.appendChild(star);
      head.appendChild(el('span', null, 'Pinned'));
      sec.appendChild(head);
      var row = el('div', 'dir-grid dir-pinned-row');
      pinned.forEach(function (a) { row.appendChild(buildCard(a, lastOpts)); });
      sec.appendChild(row);
      container.insertBefore(sec, grid);
    }

    grid.innerHTML = '';
    rest.forEach(function (a) { grid.appendChild(buildCard(a, lastOpts)); });
    if (!list.length) grid.appendChild(el('p', 'dim', 'No agents match.'));
  }

  // renderDirectory(container, agents, opts)
  // opts: { onCall(agent), onProfile(agent), stats, initialQ }
  // Renders the greeting banner (#40), the toolbar (search box only, v7.5),
  // the "Pinned" row (#39) and the filtered card grid.
  function renderDirectory(container, agents, opts) {
    if (!isBrowser() || !container) return;
    opts = opts || {};
    lastAgents = agents || [];
    lastOpts = {
      onCall: opts.onCall,
      onProfile: opts.onProfile,
      stats: opts.stats || {}
    };
    lastContainer = container;
    if (opts.initialQ != null) filters.q = String(opts.initialQ);
    // Sync partition check (async resolution below corrects after key switch).
    var skh = currentKeyHashSync();
    if (skh && skh !== pins.keyHash) { pins.keyHash = skh; pins.ids = loadPinIds(skh); }
    container.innerHTML = '';
    container.classList.add('dir-wrap');
    container.appendChild(buildGreetingBanner());
    container.appendChild(buildToolbar(container, lastAgents));
    var grid = el('div', 'dir-grid');
    grid.setAttribute('aria-label', 'All agents');
    container.appendChild(grid);
    rerenderGrid(container);
    resolvePinsKeyHash(function () { if (lastContainer === container) rerenderGrid(container); });
    refreshSuggestions();
  }

  // refreshPins() — public: re-resolve the active key's pin partition and
  // re-render. Safe to call from a key-switch hook; no-op without a container.
  function refreshPins() {
    if (!isBrowser()) return;
    resolvePinsKeyHash(function () {
      if (lastContainer) rerenderGrid(lastContainer);
      renderSuggestionChips();
    });
  }

  var Directory = {
    filterAgents: filterAgents,
    extractSwipeAction: extractSwipeAction,
    computeStatsFromHistory: computeStatsFromHistory,
    attachSwipe: attachSwipe,
    profileSheet: profileSheet,
    closeSheet: closeSheet,
    renderDirectory: renderDirectory,
    refreshPins: refreshPins,
    // v8 pure helpers (node-testable)
    greetingForHour: greetingForHour,
    normalizePinList: normalizePinList,
    toggleInList: toggleInList,
    pinsStorageKey: pinsStorageKey,
    agentKey: agentKey,
    suggestAgents: suggestAgents,
    _SWIPE_MIN_PX: SWIPE_MIN_PX
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Directory;
  global.Directory = Directory;

  // v8: resolve the active key's pin partition once the page is up so the
  // Pinned row reflects the current key even if renderDirectory ran before
  // the key hash was available.
  if (isBrowser()) {
    document.addEventListener('DOMContentLoaded', function () {
      resolvePinsKeyHash(function () {
        if (lastContainer) rerenderGrid(lastContainer);
      });
    });
  }

})((typeof window !== 'undefined') ? window : global);
