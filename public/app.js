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

  /* ---------- tabs ---------- */
  var tabs = $('tabs');
  tabs.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    sfx('tap');
    tabs.querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + b.dataset.view); });
    if (b.dataset.view === 'agents') { renderAgents($('agentSearch').value); loadStats(); }
    if (b.dataset.view === 'history') loadHistory();
    if (b.dataset.view === 'memory') loadMemories();
  });

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

  /* ---------- agents ---------- */
  var AGENTS = [];
  async function loadAgents() {
    var r = await fetch('api/agents'); var j = await r.json(); AGENTS = j.agents || [];
    renderAgents('');
  }
  function renderAgents(q) {
    q = (q || '').toLowerCase();
    var g = $('agentGrid'); g.innerHTML = '';
    // SymAgent gets a featured hero card above the grid (own row, excluded from the grid when unfiltered).
    if (!q) {
      var sa = AGENTS.filter(function (a) { return a.id === 'symagent'; })[0];
      if (sa) {
        var h = document.createElement('div'); h.className = 'hero-card rise';
        h.innerHTML = '<div class="hero-badge">OUR AI REPRESENTATIVE</div>' +
          '<div class="hero-row"><div class="avatar lg"></div>' +
          '<div class="hero-info"><div class="a-name"></div><div class="a-niche"></div>' +
          '<div class="a-num mono"></div><div class="a-tag"></div></div></div>';
        h.querySelector('.avatar').innerHTML = avatarHTML(sa);
        h.querySelector('.a-name').textContent = sa.name;
        h.querySelector('.a-niche').textContent = sa.niche;
        h.querySelector('.a-num').textContent = sa.number;
        h.querySelector('.a-tag').textContent = sa.tagline;
        var hb = document.createElement('button'); hb.className = 'btn primary hero-btn'; hb.type = 'button';
        hb.innerHTML = ICON_PHONE + '<span>Talk to SymAgent</span>';
        hb.onclick = function () { sfx('tap'); startCall({ agentId: 'symagent' }); };
        h.appendChild(hb); g.appendChild(h);
      }
    }
    var i = 0;
    AGENTS.filter(function (a) {
      if (!q && a.id === 'symagent') return false;
      return !q || (a.name + ' ' + a.niche + ' ' + a.tagline + ' ' + a.number).toLowerCase().includes(q);
    }).forEach(function (a) {
      var d = document.createElement('div'); d.className = 'acard';
      if (!q) { d.classList.add('rise'); d.style.animationDelay = ((i % 12) * 35) + 'ms'; }
      i++;
      d.innerHTML = '<div class="a-top"><div class="avatar"></div><div><div class="a-name"></div><div class="a-niche"></div></div></div>' +
        '<div class="a-num mono"></div><div class="a-tag"></div>';
      d.querySelector('.avatar').innerHTML = avatarHTML(a);
      d.querySelector('.a-name').textContent = a.name;
      d.querySelector('.a-niche').textContent = a.niche;
      d.querySelector('.a-num').textContent = a.number;
      d.querySelector('.a-tag').textContent = a.tagline;
      var b = document.createElement('button'); b.className = 'btn call'; b.type = 'button';
      b.innerHTML = ICON_PHONE + '<span>Call</span>';
      b.onclick = function () { sfx('tap'); startCall({ agentId: a.id }); };
      d.appendChild(b); g.appendChild(d);
    });
    if (!g.children.length) g.innerHTML = '<p class="dim">No agents match.</p>';
  }
  $('agentSearch').addEventListener('input', function (e) { renderAgents(e.target.value); });
  loadAgents().then(function () { loadStats(); }).catch(function () {});

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
    try { s = (await (await fetch('api/stats')).json()).stats; } catch (e) { return; }
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
  async function loadHistory() {
    var list = $('historyList'), detail = $('histDetail');
    detail.classList.add('hidden'); detail.innerHTML = '';
    list.innerHTML = '';
    try {
      var r = await fetch('api/history'); var j = await r.json();
      var calls = (j.calls || []).slice().reverse();
      if (!calls.length) { list.innerHTML = '<p class="dim">No calls yet — your history will appear here.</p>'; return; }
      calls.forEach(function (c) {
        var a = AGENTS.find(function (x) { return x.id === c.agentId; });
        var d = document.createElement('div'); d.className = 'hrow';
        d.innerHTML = '<div class="who"><div class="avatar"></div><div><div class="a-name"></div>' +
          '<div class="dim mono tiny"></div></div></div><div class="mono dim tiny"></div>';
        d.querySelector('.avatar').innerHTML = avatarHTML({ id: c.agentId || '?', color: a ? a.color : '#666' });
        d.querySelector('.a-name').textContent = c.agentName || 'Unknown';
        d.querySelectorAll('.dim')[0].textContent = (c.number || '') + ' · ' + fmtWhen(c.startedAt);
        d.querySelectorAll('.mono')[1].textContent = fmtDur(c.durationSec);
        var b = document.createElement('button'); b.className = 'btn ghost'; b.type = 'button';
        b.innerHTML = ICON_PHONE; b.title = 'Call again'; b.setAttribute('aria-label', 'Call again');
        b.onclick = function (e) { e.stopPropagation(); startCall({ agentId: c.agentId }); };
        d.appendChild(b); list.appendChild(d);
        d.style.cursor = 'pointer';
        d.onclick = function () { openHistoryDetail(c.id); };
      });
    } catch (e) { list.innerHTML = '<p class="dim">Could not load history.</p>'; }
  }
  $('clearHistory').onclick = async function () {
    if (!confirm('Clear all call history?')) return;
    await fetch('api/history', { method: 'DELETE' }); loadHistory();
  };

  /* Per-call detail: summary + device recording. */
  async function openHistoryDetail(id) {
    var detail = $('histDetail'), list = $('historyList');
    var calls = [];
    try { calls = ((await (await fetch('api/history')).json()).calls) || []; } catch (e) { return; }
    var c = null;
    for (var i = 0; i < calls.length; i++) if (calls[i].id === id) { c = calls[i]; break; }
    if (!c) return;
    var a = AGENTS.find(function (x) { return x.id === c.agentId; });
    list.innerHTML = '';
    detail.classList.remove('hidden');
    detail.innerHTML =
      '<div class="card mem-detail"><div class="mem-head"><button class="btn ghost" id="histBack" type="button">← Back</button></div>' +
      '<div class="a-top"><div class="avatar" id="histAvatar"></div><div><div class="a-name" id="histName"></div>' +
      '<div class="dim tiny" id="histMeta"></div></div></div>' +
      '<div class="det-sec"><h3>Summary</h3><div class="det-summary" id="histSummary"></div></div>' +
      '<div class="det-sec"><h3>Recording</h3><p class="dim tiny" id="histRecState">Checking…</p>' +
      '<div class="det-row-btns"><button class="btn ghost" id="histRecDl" type="button">Download audio</button>' +
      '<button class="btn ghost danger" id="histRecDel" type="button">Delete recording</button></div></div></div>';
    $('histAvatar').innerHTML = avatarHTML({ id: c.agentId || '?', color: a ? a.color : '#666' });
    $('histName').textContent = c.agentName || 'Unknown';
    $('histMeta').textContent = (c.number || '') + ' · ' + fmtWhen(c.startedAt) + ' · ' + fmtDur(c.durationSec);
    $('histSummary').textContent = c.summary || 'No summary for this call.';
    $('histBack').onclick = loadHistory;
    var dl = $('histRecDl'), del = $('histRecDel'), st = $('histRecState');
    dl.style.display = 'none'; del.style.display = 'none';
    idb.get(id).then(function (rec) {
      if (rec && rec.blob) {
        st.textContent = 'Recorded on this device — never uploaded.';
        dl.style.display = ''; del.style.display = '';
        dl.onclick = function () {
          var u = URL.createObjectURL(rec.blob);
          var aEl = document.createElement('a');
          aEl.href = u; aEl.download = 'call-' + id + '.webm';
          document.body.appendChild(aEl); aEl.click(); aEl.remove();
          setTimeout(function () { URL.revokeObjectURL(u); }, 5000);
        };
        del.onclick = function () {
          if (!confirm('Delete this recording?')) return;
          idb.del(id).then(function () {
            dl.style.display = 'none'; del.style.display = 'none';
            st.textContent = 'No recording for this call.';
          }).catch(function () {});
        };
      } else {
        st.textContent = 'No recording for this call.';
      }
    }).catch(function () { st.textContent = 'No recording for this call.'; });
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
      var r = await fetch('api/memories'); var j = await r.json();
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
  async function openMemory(id) {
    var detail = $('memoryDetail'), list = $('memoryList');
    try {
      var r = await fetch('api/memories/' + encodeURIComponent(id));
      if (!r.ok) return;
      var m = (await r.json()).memory;
      var a = AGENTS.find(function (x) { return x.id === m.agentId; });
      list.innerHTML = '';
      detail.classList.remove('hidden');
      var notesHtml = (m.notes && m.notes.length)
        ? m.notes.map(function (n) { return '<li></li>'; }).join('')
        : '<li class="dim">No notes recorded on this call.</li>';
      var trHtml = (m.transcript && m.transcript.length)
        ? m.transcript.map(function (t) { return '<div class="cbub ' + (t.who === 'user' ? 'user' : 'omni') + '"></div>'; }).join('')
        : '<p class="dim">No transcript captured.</p>';
      detail.innerHTML =
        '<div class="card mem-detail"><div class="mem-head"><button class="btn ghost" id="memBack" type="button">← Back</button>' +
        '<button class="btn ghost danger" id="memDelete" type="button">Delete</button></div>' +
        '<div class="a-top"><div class="avatar" id="memAvatar"></div><div><div class="a-name" id="memName"></div>' +
        '<div class="dim tiny" id="memMeta"></div></div></div>' +
        '<h3>Notes & appointments</h3><ul class="notes" id="memNotes">' + notesHtml + '</ul>' +
        '<h3>Transcript</h3><div class="chat-log mem-log" id="memTranscript">' + trHtml + '</div></div>';
      $('memAvatar').innerHTML = avatarHTML({ id: m.agentId || '?', color: a ? a.color : '#666' });
      $('memName').textContent = m.agentName || 'Unknown';
      $('memMeta').textContent = (m.number || '') + ' · ' + memWhen(m.startedAt) + ' · ' + fmtDur(m.durationSec);
      var noteLis = detail.querySelectorAll('#memNotes li');
      (m.notes || []).forEach(function (n, i) { if (noteLis[i]) noteLis[i].textContent = n.text; });
      var trBubs = detail.querySelectorAll('#memTranscript .cbub');
      (m.transcript || []).forEach(function (t, i) { if (trBubs[i]) trBubs[i].textContent = t.text; });
      $('memBack').onclick = loadMemories;
      $('memDelete').onclick = async function () {
        if (!confirm('Delete this memory?')) return;
        await fetch('api/memories/' + encodeURIComponent(id), { method: 'DELETE' });
        loadMemories();
      };
    } catch (e) {}
  }
  $('clearMemories').onclick = async function () {
    if (!confirm('Delete ALL memories?')) return;
    await fetch('api/memories', { method: 'DELETE' }); loadMemories();
  };
  $('backupMemories').onclick = async function () {
    sfx('tap');
    try {
      var mems = ((await (await fetch('api/memories')).json()).memories) || [];
      var calls = ((await (await fetch('api/history')).json()).calls) || [];
      var payload = JSON.stringify({
        app: 'symbiote-calling', version: '6.0.0',
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
      var r = await fetch('api/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memories: data.memories, history: data.history })
      });
      if (!r.ok) { alert('Restore failed.'); return; }
      loadMemories();
      if (document.querySelector('#view-history').classList.contains('active')) loadHistory();
    } catch (err) { alert('Could not read that file.'); }
  });

  /* ---------- settings ---------- */
  $('keyInput').addEventListener('input', function (e) {
    settings.apiKey = e.target.value.trim();
    $('keyState').textContent = settings.apiKey ? 'Key set for this page session (memory only — never stored)' : 'No key entered';
  });
  $('modelInput').value = settings.model;
  $('modelInput').addEventListener('input', function (e) { settings.model = e.target.value.trim() || 'gemini-3.8-live'; persistSettings(); });
  $('micDefault').checked = settings.mic;
  $('micDefault').addEventListener('change', function (e) { settings.mic = e.target.checked; persistSettings(); });

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
    del: function (callId) { return this._tx('readwrite', function (st) { return st.delete(callId); }); }
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
      if (settings.apiKey && transcript.length && typeof CallSummary !== 'undefined') {
        CallSummary.summarize(settings.apiKey, transcript).then(function (summary) {
          if (summary && cid) {
            fetch('api/history/' + encodeURIComponent(cid) + '/summary', {
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

    if (settings.mic) await startMic();

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/live');
    ws.onopen = function () {
      var setup = { type: 'setup', apiKey: settings.apiKey, model: settings.model };
      if (target.agentId) setup.agentId = target.agentId; else setup.number = target.number;
      ws.send(JSON.stringify(setup));
    };
    ws.onmessage = onServer;
    var closeTok = callToken;
    ws.onclose = function () { if (closeTok === callToken) endCallUI('Call ended'); };
    ws.onerror = function () {};
  }

  function onServer(ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
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
        timerInt = setInterval(function () { setCallState(fmtTimer(), 'live'); recTick(); }, 1000);
        // Fallback: if the greeting never arrives, open the mic anyway.
        if (greetFallbackT) clearTimeout(greetFallbackT);
        greetFallbackT = setTimeout(ungateMic, 10000);
        startRecording();
        break;
      case 'call_id':
        if (msg.callId) callId = msg.callId;
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
      case 'diag': $('diagBox').textContent = JSON.stringify(msg, null, 1); break;
      case 'error':
        if (msg.code === 'NO_SUCH_NUMBER') { setCallState('Number not in service', 'err'); setTimeout(teardown, 1800); }
        else if (msg.code === 'NO_KEY') { setCallState('Add your API key in Settings', 'err'); setTimeout(teardown, 2200); }
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
    callAgent = null;
    $('callOverlay').classList.add('hidden');
    $('callOverlay').setAttribute('aria-hidden', 'true');
    if (document.querySelector('#view-history').classList.contains('active')) loadHistory();
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
  f.textContent = 'Symbiote Calling v6.0 · 101 agents · local demo — fictional numbers, not a real phone network.';
  document.getElementById('main').appendChild(f);
})();
