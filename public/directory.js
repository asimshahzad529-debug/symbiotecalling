'use strict';
/* public/directory.js — v7.0.0 WS4 "Directory UX".
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

  // Build one agent card using the same markup/classes as app.js renderAgents:
  // .acard > (.a-top > .avatar + (.a-name, .a-niche)) + .a-num.mono + .a-tag + .btn.call
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
    grid.innerHTML = '';
    list.forEach(function (a) { grid.appendChild(buildCard(a, lastOpts)); });
    if (!list.length) grid.appendChild(el('p', 'dim', 'No agents match.'));
  }

  // renderDirectory(container, agents, opts)
  // opts: { onCall(agent), onProfile(agent), stats, initialQ }
  // Renders the toolbar (search box only, v7.5 — the gender/role dropdowns
  // were removed) and the filtered card grid.
  function renderDirectory(container, agents, opts) {
    if (!isBrowser() || !container) return;
    opts = opts || {};
    lastAgents = agents || [];
    lastOpts = {
      onCall: opts.onCall,
      onProfile: opts.onProfile,
      stats: opts.stats || {}
    };
    if (opts.initialQ != null) filters.q = String(opts.initialQ);
    container.innerHTML = '';
    container.classList.add('dir-wrap');
    container.appendChild(buildToolbar(container, lastAgents));
    var grid = el('div', 'dir-grid');
    container.appendChild(grid);
    rerenderGrid(container);
  }

  var Directory = {
    filterAgents: filterAgents,
    extractSwipeAction: extractSwipeAction,
    computeStatsFromHistory: computeStatsFromHistory,
    attachSwipe: attachSwipe,
    profileSheet: profileSheet,
    closeSheet: closeSheet,
    renderDirectory: renderDirectory,
    _SWIPE_MIN_PX: SWIPE_MIN_PX
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Directory;
  global.Directory = Directory;

})((typeof window !== 'undefined') ? window : global);
