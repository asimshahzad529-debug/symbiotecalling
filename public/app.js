'use strict';
/* Symbiote Calling — frontend.
 * Same-origin only: WS /live + /api/*. The API key lives in a JS variable
 * for this page session — never localStorage, never a URL.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- theme ---------- */
  var ICON_SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><line x1="12" y1="2.5" x2="12" y2="5.5"/><line x1="12" y1="18.5" x2="12" y2="21.5"/><line x1="2.5" y1="12" x2="5.5" y2="12"/><line x1="18.5" y1="12" x2="21.5" y2="12"/><line x1="4.9" y1="4.9" x2="7" y2="7"/><line x1="17" y1="17" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="7" y2="17"/><line x1="17" y1="7" x2="19.1" y2="4.9"/></svg>';
  var ICON_MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13.5A8.5 8.5 0 0 1 10.5 4 8.5 8.5 0 1 0 20 13.5z"/></svg>';
  var ICON_PHONE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg>';
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeToggle').innerHTML = t === 'dark' ? ICON_SUN : ICON_MOON;
    $('themeToggle').setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    var cb = $('themeDefault'); if (cb) cb.checked = (t === 'dark');
    try { localStorage.setItem('symbiote-theme', t); } catch (e) {}
  }
  var settings = { apiKey: '', model: 'gemini-3.8-live', mic: true };
  try {
    var saved = JSON.parse(localStorage.getItem('symbiote-calling') || '{}');
    if (saved.model) settings.model = saved.model;
    if (typeof saved.mic === 'boolean') settings.mic = saved.mic;
    applyTheme(localStorage.getItem('symbiote-theme') || 'light');
  } catch (e) { applyTheme('light'); }
  function persistSettings() {
    try { localStorage.setItem('symbiote-calling', JSON.stringify({ model: settings.model, mic: settings.mic })); } catch (e) {}
  }
  $('themeToggle').onclick = function () { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); };
  var themeCb = $('themeDefault');
  if (themeCb) themeCb.onchange = function (e) { applyTheme(e.target.checked ? 'dark' : 'light'); };

  /* ---------- tabs (v7: Agents / Custom Agents / Dashboard / Dialer /
     Agents / Custom Agents / Dashboard / Dialer / Memory / Docs(link) / Settings) ---------- */
  var tabs = $('tabs');
  function switchTab(view) {
    tabs.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    if (view === 'agents') renderDirectoryView();
    if (view === 'customagents' && window.CustomAgents) window.CustomAgents.renderPage($('customAgentsRoot'));
    if (view === 'dashboard') { loadStats(); loadDashboardRecents(); }
    if (view === 'dialer') renderDialRecents();
    if (view === 'memory') loadMemories();
    if (view === 'settings') { refreshKeyState(); }
  }
  tabs.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    sfx('tap');
    switchTab(b.dataset.view);
  });
  // WS2/WS7 adapter: directory profile sheet "Clone" opens the builder here.
  window.addEventListener('customagents:open-builder', function () { switchTab('customagents'); });

  /* ---------- API (v7 key-gated: x-key-hash attached automatically) ---------- */
  function apiFetch(path, opts) {
    if (window.KeyGate && typeof window.KeyGate.apiFetch === 'function') return window.KeyGate.apiFetch(path, opts);
    return fetch(path, opts);
  }
  function activeApiKey() {
    if (window.KeyGate && typeof window.KeyGate.getKey === 'function') {
      var k = window.KeyGate.getKey();
      if (k) return k;
    }
    return settings.apiKey;
  }

  /* ---------- sfx (tiny WebAudio blips) ---------- */
  var sfxCtx = null;
  function sfx(name) {
    try {
      if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      var t = sfxCtx.currentTime;
      function tone(f, dur, delay, vol) {
        var o = sfxCtx.createOscillator(), g = sfxCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + delay);
        g.gain.exponentialRampToValueAtTime(vol || 0.05, t + delay + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
        o.connect(g); g.connect(sfxCtx.destination);
        o.start(t + delay); o.stop(t + delay + dur + 0.05);
      }
      if (name === 'tap') tone(660, 0.055, 0);
      else if (name === 'connect') { tone(523, 0.09, 0); tone(784, 0.13, 0.09); }
      else if (name === 'hangup') tone(233, 0.14, 0);
      else if (name === 'message') tone(880, 0.05, 0, 0.035);
    } catch (e) {}
  }

  /* ---------- agents (v7: Directory UX + custom-agent merge) ---------- */
  var AGENTS = [];
  var lastHistoryCalls = [];
  async function loadAgents() {
    var r = await apiFetch('api/agents'); var j = await r.json();
    var builtin = j.agents || [];
    var custom = [];
    try {
      if (window.CustomAgents && typeof window.CustomAgents.fetchCustomAgents === 'function') {
        custom = await window.CustomAgents.fetchCustomAgents();
      }
    } catch (e) { custom = []; }
    AGENTS = (window.CustomAgents && typeof window.CustomAgents.mergeAgentLists === 'function')
      ? window.CustomAgents.mergeAgentLists(builtin, custom)
      : builtin;
    renderDirectoryView('');
  }
  function renderDirectoryView(initialQ) {
    var grid = $('agentGrid');
    if (!grid) return;
    if (!(window.Directory && typeof window.Directory.renderDirectory === 'function')) return;
    // Per-agent stats for profile sheets, aggregated from call history.
    var statsMap = {}, seen = {};
    (lastHistoryCalls || []).forEach(function (c) {
      if (c && c.agentId && !seen[c.agentId]) {
        seen[c.agentId] = true;
        statsMap[c.agentId] = window.Directory.computeStatsFromHistory(lastHistoryCalls, c.agentId);
      }
    });
    var opts = {
      stats: statsMap,
      onCall: function (a) { sfx('tap'); startCall({ agentId: a.id }); },
      onProfile: openProfileSheet
    };
    if (initialQ != null) opts.initialQ = initialQ;
    window.Directory.renderDirectory(grid, AGENTS, opts);
  }
  function openProfileSheet(agent) {
    if (!window.Directory) return;
    var stats = window.Directory.computeStatsFromHistory(lastHistoryCalls || [], agent.id);
    window.Directory.profileSheet(agent, stats, {
      onCall: function (a) { sfx('tap'); startCall({ agentId: a.id }); }
    });
  }

  /* ---------- v7.5 reactivity: custom-agent changes refresh instantly ----------
   * custom-agents.js emits `custom-agents-changed` (via public/custom-events.js)
   * after every successful create/update/delete. Both consumers subscribe here
   * through one refresh: loadAgents() re-merges built-ins + the ACTIVE key's
   * custom agents into AGENTS, re-renders the directory (renderDirectoryView),
   * and the dialer filters the same AGENTS list — so the agent appears in the
   * Agents list AND is dialable immediately, with no page reload. Refreshes are
   * serialized: a second event while one refresh is in flight queues exactly
   * one follow-up run. */
  var agentsRefreshRunning = false, agentsRefreshQueued = false;
  function queueAgentsRefresh() {
    if (agentsRefreshRunning) { agentsRefreshQueued = true; return; }
    agentsRefreshRunning = true;
    loadAgents().catch(function () {}).then(function () {
      agentsRefreshRunning = false;
      if (agentsRefreshQueued) { agentsRefreshQueued = false; queueAgentsRefresh(); }
    });
  }
  window.addEventListener('custom-agents-changed', function () { queueAgentsRefresh(); });

  /* ---------- dashboard ---------- */
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  var ICON_CLOCK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>';
  var ICON_LEAD = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><line x1="18" y1="8" x2="18" y2="14"/><line x1="15" y1="11" x2="21" y2="11"/></svg>';
  var ICON_STAR = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>';
  async function loadStats() {
    var row = $('statsRow'); if (!row) return;
    var s = null;
    try { s = (await (await apiFetch('api/stats')).json()).stats; } catch (e) { return; }
    if (!s) return;
    row.classList.remove('stats');
    row.innerHTML = '';
    var grid = el('div', 'stats');
    [['calls', ICON_PHONE, s.totalCalls, 'Calls'],
     ['mins', ICON_CLOCK, s.totalMinutes, 'Minutes'],
     ['leads', ICON_LEAD, s.leadsCaptured, 'Leads'],
     ['top', ICON_STAR, (s.topAgents || []).length, 'Top agents']].forEach(function (c) {
      var card = el('div', 'stat-card');
      var ic = el('div', 'stat-ic'); ic.innerHTML = c[1];
      var tx = el('div');
      tx.appendChild(el('div', 'stat-num', String(c[2] == null ? 0 : c[2])));
      tx.appendChild(el('div', 'stat-lbl', c[3]));
      card.appendChild(ic); card.appendChild(tx); grid.appendChild(card);
    });
    row.appendChild(grid);
    if ((s.topAgents || []).length) {
      var t5 = el('div', 'top5');
      t5.appendChild(el('h4', null, 'Most called'));
      s.topAgents.forEach(function (t, i) {
        var r = el('div', 'top5-row');
        var match = AGENTS.filter(function (x) { return x.id === t.agentId; })[0];
        var av = el('div', 'avatar');
        av.innerHTML = avatarHTML({ id: t.agentId || '?', color: match ? match.color : '#666' });
        r.appendChild(av);
        r.appendChild(el('div', 't-name', (i + 1) + '. ' + (t.agentName || 'Unknown')));
        r.appendChild(el('div', 't-meta mono', t.calls + ' calls · ' + t.minutes + ' min'));
        t5.appendChild(r);
      });
      row.appendChild(t5);
    }
  }

  /* ---------- v7 dashboard recents + dialer recents (CallX) ---------- */
  async function loadDashboardRecents() {
    var box = $('dashRecents');
    if (!box) return;
    try {
      var calls = ((await (await apiFetch('api/history')).json()).calls) || [];
      lastHistoryCalls = calls;
      if (window.CallX && typeof window.CallX.renderDashboardRecents === 'function') {
        window.CallX.renderDashboardRecents(box, calls, function (c) {
          sfx('tap');
          if (c.agentId) startCall({ agentId: c.agentId });
          else if (c.number) startCall({ number: c.number });
        });
      }
    } catch (e) {}
  }
  function renderDialRecents() {
    var box = $('dialRecents');
    if (!box || !(window.CallX && typeof window.CallX.renderRecents === 'function')) return;
    try {
      window.CallX.renderRecents(box, function (entry) {
        sfx('tap');
        startCall({ number: entry.number, agentId: entry.agentId });
      });
    } catch (e) {}
  }
  /* ---------- v7.5: dialer recents follow the active key ----------
   * Dialer recents are per-key partitions (CallX.recents.setScope). Re-scope
   * on boot and on every key switch so one key's recents never show under
   * another key, then re-render the dialer recents view. */
  function scopeRecentsToActiveKey() {
    try {
      if (window.KeyGate && typeof window.KeyGate.getKeyHash === 'function' &&
          window.CallX && window.CallX.recents && typeof window.CallX.recents.setScope === 'function') {
        window.KeyGate.getKeyHash().then(function (kh) {
          window.CallX.recents.setScope(kh);
          renderDialRecents();
        }).catch(function () {});
      }
    } catch (e) {}
  }
  /* ---------- dialer ---------- */
  var DIAL_KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
  var dialNum = '';
  function buildPad(el, onPress) {
    DIAL_KEYS.forEach(function (k) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'key';
      b.innerHTML = '<span></span>' + (k[1] ? '<small></small>' : '');
      b.querySelector('span').textContent = k[0];
      if (k[1]) b.querySelector('small').textContent = k[1];
      b.onclick = function () { dtmf(k[0]); onPress(k[0]); };
      el.appendChild(b);
    });
  }
  function renderDial() {
    $('dialDisplay').textContent = dialNum;
    renderDialMatches();
  }
  function dialDigits(s) { return String(s || '').replace(/\D/g, ''); }
  function renderDialMatches() {
    var box = $('dialResults');
    var d = dialDigits(dialNum);
    box.innerHTML = '';
    if (!d) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var matches = AGENTS.filter(function (a) { return dialDigits(a.number).indexOf(d) !== -1; });
    if (!matches.length) {
      box.innerHTML = '<p class="dim tiny">No agent found for this number.</p>';
      return;
    }
    var exact = matches.filter(function (a) { return dialDigits(a.number).slice(-10) === d.slice(-10) && d.length >= 7; });
    var shown = (exact.length ? exact : matches).slice(0, 5);
    shown.forEach(function (a) {
      var isExact = dialDigits(a.number).slice(-10) === d.slice(-10) && d.length >= 7;
      var row = document.createElement('div');
      row.className = 'dial-match' + (isExact ? ' exact' : '');
      row.innerHTML = '<div class="avatar sm"></div><div class="dm-info"><div class="a-name"></div><div class="a-num mono"></div></div><button class="icon-btn sm" type="button" aria-label="Call"></button>';
      row.querySelector('.avatar').innerHTML = avatarHTML(a);
      row.querySelector('.a-name').textContent = a.name;
      row.querySelector('.a-num').textContent = a.number;
      row.querySelector('.icon-btn').innerHTML = ICON_PHONE;
      row.querySelector('.icon-btn').onclick = function (e) { e.stopPropagation(); startCall({ agentId: a.id }); };
      row.onclick = function () { startCall({ agentId: a.id }); };
      box.appendChild(row);
    });
    if (matches.length > shown.length) {
      var more = document.createElement('p'); more.className = 'dim tiny'; more.textContent = '+' + (matches.length - shown.length) + ' more — keep typing to narrow down';
      box.appendChild(more);
    }
  }
  buildPad($('dialPad'), function (d) { if (dialNum.replace(/\D/g, '').length < 15) { dialNum += d; renderDial(); } });
  $('dialBack').onclick = function () { dialNum = dialNum.slice(0, -1); renderDial(); };
  $('dialCall').onclick = function () { if (dialNum.replace(/\D/g, '').length >= 3) startCall({ number: dialNum }); };
  buildPad($('callPad'), function (d) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'keypad', digit: d }));
  });
  $('keypadClose').onclick = function () { $('keypadSheet').classList.add('hidden'); };
  $('chatClose').onclick = function () { $('chatSheet').classList.add('hidden'); };

  /* ---------- DTMF tones (local only) ---------- */
  var dtmfCtx = null;
  var DTMF = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477] };
  function dtmf(d) {
    try {
      dtmfCtx = dtmfCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (dtmfCtx.state === 'suspended') dtmfCtx.resume();
      var f = DTMF[d]; if (!f) return;
      var t = dtmfCtx.currentTime;
      f.forEach(function (fr) {
        var o = dtmfCtx.createOscillator(), g = dtmfCtx.createGain();
        o.type = 'sine'; o.frequency.value = fr;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g); g.connect(dtmfCtx.destination); o.start(t); o.stop(t + 0.25);
      });
    } catch (e) {}
  }

  /* ---------- history ---------- */
  function fmtDur(s) {
    if (s == null) return '—';
    var m = Math.floor(s / 60), sec = s % 60;
    return (m < 10 ? '0' + m : m) + ':' + (sec < 10 ? '0' + sec : sec);
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  /* ---------- memory ---------- */
  function memWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  async function loadMemories() {
    var list = $('memoryList'), detail = $('memoryDetail');
    detail.classList.add('hidden'); detail.innerHTML = '';
    list.innerHTML = '';
    try {
      var r = await apiFetch('api/memories'); var j = await r.json();
      var mems = j.memories || [];
      if (!mems.length) { list.innerHTML = '<p class="dim">No memories yet — they are saved automatically after each call.</p>'; return; }
      mems.forEach(function (m) {
        var a = AGENTS.find(function (x) { return x.id === m.agentId; });
        var d = document.createElement('div'); d.className = 'hrow memrow';
        d.innerHTML = '<div class="who"><div class="avatar"></div><div><div class="a-name"></div>' +
          '<div class="dim tiny"></div></div></div><div class="dim tiny"></div>';
        d.querySelector('.avatar').innerHTML = avatarHTML({ id: m.agentId || '?', color: a ? a.color : '#666' });
        d.querySelector('.a-name').textContent = m.agentName || 'Unknown';
        d.querySelectorAll('.dim')[0].textContent = memWhen(m.startedAt) + ' · ' + fmtDur(m.durationSec);
        d.querySelectorAll('.dim')[1].textContent = (m.noteCount || 0) + ' notes · ' + (m.turns || 0) + ' messages';
        d.style.cursor = 'pointer';
        d.onclick = function () { openMemory(m.id); };
        list.appendChild(d);
      });
    } catch (e) { list.innerHTML = '<p class="dim">Could not load memories.</p>'; }
  }
  /* Memory detail (v7.5): the AI-written post-call summary ONLY. Full
   * transcripts are never rendered inline — they download as a text file.
   * The device recording (keyed by the memory entry's callId, linked
   * server-side at call start) downloads too when one exists. */
  async function openMemory(id) {
    var detail = $('memoryDetail'), list = $('memoryList');
    try {
      var r = await apiFetch('api/memories/' + encodeURIComponent(id));
      if (!r.ok) return;
      var m = (await r.json()).memory;
      var a = AGENTS.find(function (x) { return x.id === m.agentId; });
      list.innerHTML = '';
      detail.classList.remove('hidden');
      detail.innerHTML =
        '<div class="card mem-detail"><div class="mem-head"><button class="btn ghost" id="memBack" type="button">← Back</button>' +
        '<button class="btn ghost danger" id="memDelete" type="button">Delete</button></div>' +
        '<div class="a-top"><div class="avatar" id="memAvatar"></div><div><div class="a-name" id="memName"></div>' +
        '<div class="dim tiny" id="memMeta"></div></div></div>' +
        '<div class="det-sec"><h3>Summary</h3><div class="det-summary" id="memSummary"></div></div>' +
        '<div class="det-row-btns"><button class="btn ghost" id="memDlTranscript" type="button">Download transcript</button>' +
        '<button class="btn ghost" id="memDlAudio" type="button" style="display:none">Download audio</button></div></div>';
      $('memAvatar').innerHTML = avatarHTML({ id: m.agentId || '?', color: a ? a.color : '#666' });
      $('memName').textContent = m.agentName || 'Unknown';
      $('memMeta').textContent = (m.number || '') + ' · ' + memWhen(m.startedAt) + ' · ' + fmtDur(m.durationSec);
      $('memSummary').textContent = m.summary || 'No summary for this call.';
      $('memBack').onclick = loadMemories;
      var memDlT = $('memDlTranscript');
      if (memDlT) memDlT.onclick = function () {
        sfx('tap');
        try {
          if (window.CallX) CallX.downloadTranscript(id, { lines: m.transcript, agentName: m.agentName });
        } catch (e) {}
      };
      // Device recording download: shown only when a recording exists for
      // this call (IndexedDB, device only — never uploaded).
      var memDlA = $('memDlAudio');
      if (m.callId && memDlA) {
        idb.get(m.callId).then(function (rec) {
          if (!rec || !rec.blob) return;
          memDlA.style.display = '';
          memDlA.onclick = function () {
            sfx('tap');
            var u = URL.createObjectURL(rec.blob);
            var aEl = document.createElement('a');
            aEl.href = u; aEl.download = 'call-' + String(m.callId).replace(/[^A-Za-z0-9_-]/g, '_') + '.webm';
            document.body.appendChild(aEl); aEl.click(); aEl.remove();
            setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
          };
        }).catch(function () {});
      }
      $('memDelete').onclick = async function () {
        if (!confirm('Delete this memory?')) return;
        await apiFetch('api/memories/' + encodeURIComponent(id), { method: 'DELETE' });
        loadMemories();
      };
    } catch (e) {}
  }
  $('clearMemories').onclick = async function () {
    if (!confirm('Delete ALL memories?')) return;
    await apiFetch('api/memories', { method: 'DELETE' }); loadMemories();
  };
  $('backupMemories').onclick = async function () {
    sfx('tap');
    try {
      var mems = ((await (await apiFetch('api/memories')).json()).memories) || [];
      var calls = ((await (await apiFetch('api/history')).json()).calls) || [];
      var payload = JSON.stringify({
        app: 'symbiote-calling', version: '7.5.0',
        exportedAt: new Date().toISOString(), memories: mems, history: calls
      }, null, 2);
      var blob = new Blob([payload], { type: 'application/json' });
      var u = URL.createObjectURL(blob);
      var aEl = document.createElement('a');
      aEl.href = u; aEl.download = 'symbiote-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(aEl); aEl.click(); aEl.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
    } catch (e) {}
  };
  $('restoreMemories').onclick = function () { $('restoreFile').click(); };
  $('restoreFile').addEventListener('change', async function (e) {
    var f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      var data = JSON.parse(await f.text());
      var badShape = !data || (data.memories === undefined && data.history === undefined) ||
        (data.memories !== undefined && !Array.isArray(data.memories)) ||
        (data.history !== undefined && !Array.isArray(data.history));
      if (badShape) { alert('That file is not a Symbiote backup.'); return; }
      var n = (data.memories || []).length + (data.history || []).length;
      if (!confirm('Restore ' + n + ' records? This replaces current memories and history.')) return;
      var r = await apiFetch('api/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memories: data.memories, history: data.history })
      });
      if (!r.ok) { alert('Restore failed.'); return; }
      loadMemories();
    } catch (err) { alert('Could not read that file.'); }
  });

  /* ---------- settings (v7.5: key profiles + accent color only) ---------- */
  function refreshKeyState() {
    var s = $('keyState');
    if (!s) return;
    try {
      if (window.KeyGate && typeof window.KeyGate.listLocalProfiles === 'function') {
        var key = window.KeyGate.getKey();
        var profiles = window.KeyGate.listLocalProfiles() || [];
        var active = null;
        for (var i = 0; i < profiles.length; i++) {
          if (profiles[i] && profiles[i].key === key) { active = profiles[i]; break; }
        }
        if (key && active) {
          s.textContent = 'Active key: ' + (active.label || 'unlabeled') +
            ' · hash ' + String(active.keyHash || '').slice(0, 12) + '… · ' + profiles.length + ' profile(s)';
          return;
        }
        if (key) { s.textContent = 'Key active'; return; }
      }
    } catch (e) {}
    s.textContent = settings.apiKey ? 'Key set for this page session' : 'No key entered';
  }
  var keySw = $('keySwitcher');
  if (keySw) keySw.onclick = function () {
    sfx('tap');
    if (window.KeyGate && typeof window.KeyGate.openSwitcher === 'function') {
      window.KeyGate.openSwitcher(document.body);
      setTimeout(function () {
        settings.apiKey = activeApiKey();
        refreshKeyState();
        loadAgents().catch(function () {});
        scopeRecentsToActiveKey();
      }, 800);
    }
  };
  // Call preferences (model / mic) were removed from Settings in v7.5 —
  // the saved values below keep working for users who set them before.
  var modelInput = $('modelInput');
  if (modelInput) {
    modelInput.value = settings.model;
    modelInput.addEventListener('input', function (e) { settings.model = e.target.value.trim() || 'gemini-3.8-live'; persistSettings(); });
  }
  var micCb = $('micDefault');
  if (micCb) {
    micCb.checked = settings.mic;
    micCb.addEventListener('change', function (e) { settings.mic = e.target.checked; persistSettings(); });
  }

  /* ---------- accent color picker (WS7 hygiene) ---------- */
  function buildAccentRow() {
    var row = $('accentRow');
    if (!row || !window.Hygiene) return;
    row.innerHTML = '';
    var current = window.Hygiene.initAccent();
    window.Hygiene.ACCENTS.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'accent-swatch' + (c === current ? ' active' : '');
      b.style.background = c;
      b.title = c;
      b.setAttribute('aria-label', 'Accent color ' + c);
      b.onclick = function () {
        sfx('tap');
        var hex = window.Hygiene.applyAccent(c);
        var sw = row.querySelectorAll('.accent-swatch');
        for (var i = 0; i < sw.length; i++) sw[i].classList.toggle('active', sw[i].title === hex);
      };
      row.appendChild(b);
    });
  }

  /* ---------- data retention (WS7 hygiene) ---------- */
  function idbPrune(days) {
    try { return idb.prune(days); } catch (e) { return Promise.resolve(0); }
  }
  function idbPruneOnBoot() {
    try {
      var d = window.Hygiene ? window.Hygiene.getRetentionDays() : 30;
      idbPrune(d).then(function (n) {
        if (n) console.log('[hygiene] pruned ' + n + ' device recording(s) older than ' + d + 'd');
      }).catch(function () {});
    } catch (e) {}
  }
  var retInput = $('retentionDays');
  if (retInput && window.Hygiene) {
    retInput.value = window.Hygiene.getRetentionDays();
    retInput.addEventListener('change', function () {
      var n = window.Hygiene.setRetentionDays(retInput.value);
      retInput.value = n;
      idbPrune(n);
    });
  }

  /* ---------- clock ---------- */
  function clock() {
    var d = new Date(), h = d.getHours() % 12 || 12, m = d.getMinutes();
    $('pClock').textContent = h + ':' + (m < 10 ? '0' + m : m);
  }
  clock(); setInterval(clock, 15000);

  /* ---------- call recordings (IndexedDB — device only, never uploaded) ---------- */
  var idb = {
    _db: null,
    open: function () {
      var self = this;
      if (self._db) return Promise.resolve(self._db);
      return new Promise(function (resolve, reject) {
        try {
          var rq = indexedDB.open('symbiote-calling', 1);
          rq.onupgradeneeded = function () { rq.result.createObjectStore('recordings', { keyPath: 'callId' }); };
          rq.onsuccess = function () { self._db = rq.result; resolve(self._db); };
          rq.onerror = function () { reject(rq.error || new Error('idb open failed')); };
        } catch (e) { reject(e); }
      });
    },
    _tx: function (mode, fn) {
      return this.open().then(function (db) {
        return new Promise(function (resolve, reject) {
          try {
            var tx = db.transaction('recordings', mode);
            var st = tx.objectStore('recordings');
            var rq = fn(st);
            rq.onsuccess = function () { resolve(rq.result); };
            rq.onerror = function () { reject(rq.error || new Error('idb op failed')); };
          } catch (e) { reject(e); }
        });
      });
    },
    put: function (rec) { return this._tx('readwrite', function (st) { return st.put(rec); }); },
    get: function (callId) { return this._tx('readonly', function (st) { return st.get(callId); }); },
    del: function (callId) { return this._tx('readwrite', function (st) { return st.delete(callId); }); },
    /** v7 auto-cleanup: delete recordings whose startedAt is older than
     *  `days`. Resolves the removed count; never rejects. */
    prune: function (days) {
      var self = this;
      return this.open().then(function (db) {
        return new Promise(function (resolve) {
          try {
            var rq = db.transaction('recordings', 'readonly').objectStore('recordings').getAll();
            rq.onsuccess = function () {
              var recs = rq.result || [];
              var old = recs.filter(function (r) {
                return window.Hygiene && window.Hygiene.isOlderThan(r && r.startedAt, days);
              });
              if (!old.length) return resolve(0);
              var tx = db.transaction('recordings', 'readwrite');
              var st = tx.objectStore('recordings');
              old.forEach(function (r) { try { st.delete(r.callId); } catch (e) {} });
              tx.oncomplete = function () { resolve(old.length); };
              tx.onerror = function () { resolve(0); };
            };
            rq.onerror = function () { resolve(0); };
          } catch (e) { resolve(0); }
        });
      }).catch(function () { return 0; });
    }
  };

  /* ---------- call recorder (agent audio + mic → webm) ---------- */
  function recSupported() {
    try { return typeof CallRecorder !== 'undefined' && CallRecorder.isSupported(); } catch (e) { return false; }
  }
  function startRecording() {
    if (!recSupported() || !playCtx) return;
    try {
      recDest = playCtx.createMediaStreamDestination();
      var tracks = recDest.stream.getAudioTracks().slice();
      if (micStream) { var mt = micStream.getAudioTracks()[0]; if (mt) tracks.push(mt); }
      recorder = new CallRecorder();
      if (recorder.start(new MediaStream(tracks))) {
        $('pRecTime').textContent = '00:00';
        $('pRec').classList.remove('hidden');
      } else { recorder = null; recDest = null; }
    } catch (e) { recorder = null; recDest = null; }
  }
  function recTick() {
    if (recorder && recorder.getState() === 'recording') {
      var s = Math.floor(recorder.getElapsedMs() / 1000);
      var m = Math.floor(s / 60); s %= 60;
      $('pRecTime').textContent = (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    }
  }
  function stopRecording() {
    try { $('pRec').classList.add('hidden'); } catch (e) {}
    recDest = null;
    if (!recorder) return Promise.resolve(null);
    var r = recorder; recorder = null;
    try { return r.stop(); } catch (e) { return Promise.resolve(null); }
  }

  /** Save recording + fire auto-summary once per call. Never throws. */
  function finishCallArtifacts() {
    if (artifactsDone) return;
    artifactsDone = true;
    var cid = callId, transcript = callTranscript.slice();
    var aName = callAgent ? callAgent.name : '';
    stopRecording().then(function (blob) {
      if (blob && cid) {
        idb.put({ callId: cid, blob: blob, agentName: aName, startedAt: new Date().toISOString() }).catch(function () {});
      }
    }).catch(function () {});
    try {
      var ak = activeApiKey();
      if (ak && transcript.length && typeof CallSummary !== 'undefined') {
        CallSummary.summarize(ak, transcript).then(function (summary) {
          if (summary && cid) {
            apiFetch('api/history/' + encodeURIComponent(cid) + '/summary', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ summary: summary })
            }).catch(function () {});
          }
        }).catch(function () {});
      }
    } catch (e) {}
  }
  var ws = null, callAgent = null, connectedAt = 0, timerInt = null;
  var callId = null, callToken = 0, artifactsDone = false;
  var callTranscript = [];
  var recorder = null, recDest = null;
  var muted = false, micStream = null, audioCtx = null, workletNode = null;
  var playCtx = null, nextPlayTime = 0, activeSources = [];
  // v7 greeting diagnostics (window.GreetingDiag): feed every bridge event;
  // the UI mapping for greeting_state lives in onServer().
  var greetDiag = null;
  // Greeting gate: the mic stays muted until the agent's greeting audio
  // arrives (or a fallback timeout). A live mic stream from second zero
  // makes the Live API's voice-activity detection hold back its first
  // reply forever — this half-duplex start fixes "agent never greets".
  var greetingDone = false, greetFallbackT = null;

  function ungateMic() {
    if (greetingDone) return;
    greetingDone = true;
    if (greetFallbackT) { clearTimeout(greetFallbackT); greetFallbackT = null; }
    if (workletNode && !muted) workletNode.port.postMessage({ muted: false });
  }

  function setCallState(text, cls) {
    var el = $('pState'); el.textContent = text; el.className = 'p-state' + (cls ? ' ' + cls : '');
  }
  function chatBubble(who, text) {
    var d = document.createElement('div'); d.className = 'cbub ' + who; d.textContent = text;
    var log = $('chatLog'); log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  /* Clickable link chips shared by SymAgent (share_links tool). */
  function linkChips(links) {
    if (!links || !links.length) return;
    var d = document.createElement('div'); d.className = 'cbub omni chips';
    links.forEach(function (l) {
      var a = document.createElement('a'); a.className = 'lchip'; a.textContent = l.label || l.url;
      a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; d.appendChild(a);
    });
    var log = $('chatLog'); log.appendChild(d); log.scrollTop = log.scrollHeight;
  }
  function fmtTimer() {
    var s = Math.floor((Date.now() - connectedAt) / 1000);
    var m = Math.floor(s / 60); s %= 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function ensurePlayCtx() {
    if (!playCtx) {
      playCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (playCtx.state === 'suspended') playCtx.resume().catch(function () {});
    return playCtx;
  }
  function playChunk(b64, mimeType) {
    var ctx = ensurePlayCtx();
    if (ctx.state === 'suspended') { ctx.resume().catch(function () {}); }
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    var pcm16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
    var m = /rate=(\d+)/.exec(mimeType || ''), rate = m ? parseInt(m[1], 10) : 24000;
    var buf = ctx.createBuffer(1, pcm16.length, rate), ch = buf.getChannelData(0);
    for (var j = 0; j < pcm16.length; j++) ch[j] = pcm16[j] / 32768;
    var src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    if (recDest) { try { src.connect(recDest); } catch (e) {} }
    var now = ctx.currentTime;
    if (nextPlayTime < now) nextPlayTime = now + 0.02;
    try { src.start(nextPlayTime); } catch (e) { src.start(now); nextPlayTime = now; }
    nextPlayTime += buf.duration;
    activeSources.push(src);
    src.onended = function () { var k = activeSources.indexOf(src); if (k >= 0) activeSources.splice(k, 1); };
    $('pEq').classList.remove('hidden');
  }
  function stopPlayback() {
    activeSources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    activeSources = [];
    if (playCtx) nextPlayTime = playCtx.currentTime;
    $('pEq').classList.add('hidden');
  }

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) { return false; }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.audioWorklet.addModule('worklet.js');
    var src = audioCtx.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(audioCtx, 'omni-capture');
    workletNode.port.onmessage = function (e) {
      if (e.data && typeof e.data.level === 'number') $('pMeter').style.width = Math.min(100, Math.round(e.data.level * 400)) + '%';
      try { if (window.CallX) CallX.meter.micLevel(e.data.level); } catch (err) {}
      if (e.data && e.data.pcm && ws && ws.readyState === 1) {
        var u8 = new Uint8Array(e.data.pcm), bin = '';
        for (var i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
        ws.send(JSON.stringify({ type: 'audio_in', data: btoa(bin) }));
      }
    };
    workletNode.port.postMessage({ muted: true }); // gated until greeting lands
    src.connect(workletNode);
    return true;
  }
  function stopMic() {
    if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (audioCtx) { audioCtx.close().catch(function () {}); audioCtx = null; }
    $('pMeter').style.width = '0%';
  }

  async function startCall(target) {
    if (ws) return; // one call at a time
    callToken++;
    // Create the playback context INSIDE the click gesture (autoplay policy).
    try { ensurePlayCtx(); } catch (e) {}
    // reset phone UI
    $('chatLog').innerHTML = '';
    $('keypadSheet').classList.add('hidden'); $('chatSheet').classList.add('hidden');
    $('pMute').classList.remove('on'); muted = false; greetingDone = false;
    callTranscript = []; callId = null; artifactsDone = false;
    $('pRec').classList.add('hidden');
    if (greetFallbackT) { clearTimeout(greetFallbackT); greetFallbackT = null; }
    $('pEq').classList.add('hidden');
    $('pAvatar').classList.remove('ring');
    setCallState('Dialing…');
    $('pName').textContent = '—'; $('pNumber').textContent = '—';
    $('pAvatar').innerHTML = avatarSVG({ id: 'default', color: '#3a3a48' });
    $('callOverlay').classList.remove('hidden');
    $('callOverlay').setAttribute('aria-hidden', 'false');

    // v7 CallX hooks: in-call notes, floating-bubble infra, connection
    // meter, transcript search source, per-call quota state.
    try {
      if (window.CallX) {
        CallX.notes.attach();
        CallX.notes.clear();
        CallX.bubble.attach();
        CallX.meter.attach();
        CallX.search.setSource(function () { return callTranscript; });
        CallX.quota.reset();
      }
      if (window.GreetingDiag && !greetDiag) greetDiag = window.GreetingDiag.attach(null);
    } catch (e) {}

    if (settings.mic) await startMic();

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/live');
    ws.onopen = function () {
      try { if (window.CallX) CallX.meter.netState(navigator.onLine, ws.readyState); } catch (e) {}
      var setup = { type: 'setup', apiKey: activeApiKey(), model: settings.model };
      if (target.agentId) setup.agentId = target.agentId; else setup.number = target.number;
      ws.send(JSON.stringify(setup));
    };
    ws.onmessage = onServer;
    var closeTok = callToken;
    ws.onclose = function () {
      try { if (window.CallX) CallX.meter.netState(navigator.onLine, 3); } catch (e) {}
      if (closeTok === callToken) endCallUI('Call ended');
    };
    ws.onerror = function () {
      try { if (window.CallX) CallX.meter.netState(navigator.onLine, 3); } catch (e) {}
    };
  }

  function onServer(ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    // v7 greeting diagnostics: every bridge event feeds the timeline.
    if (greetDiag) { try { greetDiag.feed(msg); } catch (e) {} }
    switch (msg.type) {
      case 'call':
        if (msg.state === 'connecting' && msg.agent) {
          callAgent = msg.agent;
          $('pName').textContent = msg.agent.name;
          $('pNumber').textContent = msg.agent.number;
          $('pAvatar').innerHTML = avatarHTML(msg.agent);
          setCallState('Connecting…');
        }
        break;
      case 'setup_complete':
        connectedAt = Date.now();
        sfx('connect');
        setCallState(fmtTimer(), 'live');
        $('pAvatar').classList.add('ring');
        timerInt = setInterval(function () {
          setCallState(fmtTimer(), 'live'); recTick();
          try { if (window.CallX) CallX.quota.check(Math.floor((Date.now() - connectedAt) / 1000)); } catch (e) {}
        }, 1000);
        // Fallback: if the greeting never arrives, open the mic anyway.
        if (greetFallbackT) clearTimeout(greetFallbackT);
        greetFallbackT = setTimeout(ungateMic, 10000);
        startRecording();
        break;
      case 'call_id':
        if (msg.callId) callId = msg.callId;
        break;
      /* v7 greeting handshake (WS3): surface the handshake state in the
       * call overlay. audio_received = normal call UI; text_received /
       * greeting_text_only = transcript bubble; failed / greeting_failed =
       * "Say hello to begin" hint. UNVERIFIED-LIVE: the handshake's real
       * behavior needs a live-key call to confirm. */
      case 'greeting_state':
        if (msg.state === 'trigger_sent' || msg.state === 'retry_sent') setCallState('greeting…');
        else if (msg.state === 'audio_received') { setCallState(fmtTimer(), 'live'); ungateMic(); }
        else if (msg.state === 'text_received') setCallState('greeting…');
        else if (msg.state === 'failed') setCallState('Say hello to begin', 'err');
        break;
      case 'greeting_text_only':
        chatBubble('omni', String(msg.text || ''));
        break;
      case 'greeting_failed':
        setCallState('Say hello to begin', 'err');
        break;
      case 'transfer':
        handleTransfer(msg.target || {});
        break;
      case 'transcript':
        chatBubble(msg.who === 'user' ? 'user' : 'omni', msg.text);
        if (callTranscript.length < 200) callTranscript.push({ who: msg.who === 'user' ? 'user' : 'agent', text: String(msg.text || '').slice(0, 2000) });
        if (msg.who !== 'user') sfx('message');
        break;
      case 'links_shared':
        linkChips(msg.links || []);
        sfx('message');
        break;
      case 'audio': ungateMic(); playChunk(msg.data, msg.mimeType); break;
      case 'turn_complete': $('pEq').classList.add('hidden'); break;
      case 'interrupted': stopPlayback(); break;
      case 'call_ended_by':
        setCallState('Call ended');
        chatBubble('omni', (msg.name || 'Agent') + ' ended the call.');
        break;
      case 'diag':
        var diagBox = $('diagBox');
        if (diagBox) diagBox.textContent = JSON.stringify(msg, null, 1);
        break;
      case 'error':
        if (msg.code === 'NO_SUCH_NUMBER') { setCallState('Number not in service', 'err'); setTimeout(teardown, 1800); }
        else if (msg.code === 'NO_KEY') { setCallState('Add your API key in Settings', 'err'); setTimeout(teardown, 2200); }
        else if (msg.code === 'RATE_LIMITED') { setCallState('Too many concurrent calls for this key', 'err'); setTimeout(teardown, 2200); }
        else if (msg.fatal) { setCallState('Connection failed', 'err'); setTimeout(teardown, 1800); }
        break;
    }
  }

  function endCallUI(text) {
    sfx('hangup');
    finishCallArtifacts();
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    stopPlayback();
    setCallState(text || 'Call ended');
    $('pAvatar').classList.remove('ring');
    setTimeout(teardown, 1200);
  }
  function teardown() {
    stopMic(); stopPlayback();
    if (timerInt) { clearInterval(timerInt); timerInt = null; }
    if (greetFallbackT) { clearTimeout(greetFallbackT); greetFallbackT = null; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    // v7 CallX: save in-call notes to the call record, restore the overlay
    // if it was minimized, and add the call to dialer recents.
    try {
      if (window.CallX) {
        CallX.notes.save(callId, null).catch(function () {});
        CallX.bubble.expand();
        if (callAgent) CallX.recents.push({ name: callAgent.name, number: callAgent.number, agentId: callAgent.id });
      }
    } catch (e) {}
    callAgent = null;
    $('callOverlay').classList.add('hidden');
    $('callOverlay').setAttribute('aria-hidden', 'true');
    if (document.querySelector('#view-dashboard').classList.contains('active')) loadDashboardRecents();
  }

  /* SymAgent transfer: close this leg, auto-dial the specialist. */
  function handleTransfer(t) {
    if (!t || !t.id) return;
    setCallState('Transferring to ' + (t.name || 'agent') + '…');
    chatBubble('omni', 'Transferring you to ' + (t.name || 'a specialist') + ' now.');
    sfx('connect');
    var tok = callToken;
    setTimeout(function () {
      if (tok !== callToken) return;
      callToken++; // suppress the old socket's onclose
      finishCallArtifacts(); // save recording + summary for the SymAgent leg
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      stopMic(); stopPlayback();
      stopRecording().catch(function () {});
      if (timerInt) { clearInterval(timerInt); timerInt = null; }
      if (greetFallbackT) { clearTimeout(greetFallbackT); greetFallbackT = null; }
      startCall({ agentId: t.id });
    }, 1600);
  }

  $('pHangup').onclick = function () {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'hangup' }));
    endCallUI('Call ended');
  };
  $('pMute').onclick = function () {
    muted = !muted;
    $('pMute').classList.toggle('on', muted);
    if (workletNode) workletNode.port.postMessage({ muted: muted || !greetingDone });
  };
  $('pKeypad').onclick = function () {
    $('chatSheet').classList.add('hidden');
    $('keypadSheet').classList.toggle('hidden');
  };
  $('pChat').onclick = function () {
    $('keypadSheet').classList.add('hidden');
    var sheet = $('chatSheet');
    sheet.classList.toggle('hidden');
    if (!sheet.classList.contains('hidden')) setTimeout(function () { $('chatInput').focus(); }, 60);
  };
  var pMinBtn = $('pMin');
  if (pMinBtn) pMinBtn.onclick = function () {
    sfx('tap');
    try { if (window.CallX) CallX.bubble.minimize(); } catch (e) {}
  };
  function sendChat() {
    var t = $('chatInput').value.trim();
    if (!t || !ws || ws.readyState !== 1) return;
    chatBubble('user', t);
    sfx('message');
    ws.send(JSON.stringify({ type: 'text', text: t }));
    $('chatInput').value = '';
  }
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
  window.addEventListener('beforeunload', function () { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'hangup' })); });

  var f = document.createElement('footer'); f.className = 'note';
  f.textContent = 'Symbiote Calling v7.5 · 101 agents + your custom agents · local demo — fictional numbers, not a real phone network.';
  document.getElementById('main').appendChild(f);

  /* ---------- v7 boot: key login gates everything ---------- */
  (async function boot() {
    try {
      if (window.KeyGate && typeof window.KeyGate.init === 'function') {
        await window.KeyGate.init(); // login overlay until a key is active
        settings.apiKey = window.KeyGate.getKey() || '';
      }
    } catch (e) { /* overlay stays up; nothing below runs without a key */ }
    if (window.Hygiene) { try { window.Hygiene.initAccent(); } catch (e) {} }
    buildAccentRow();
    refreshKeyState();
    idbPruneOnBoot();
    try { await loadAgents(); } catch (e) {}
    scopeRecentsToActiveKey();
    renderDialRecents();
  })();
})();
