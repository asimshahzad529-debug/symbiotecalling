'use strict';
/* Symbiote Calling — #38 command palette (v8).
 * Self-initializing on DOMContentLoaded. Index page only (requires #tabs).
 * Injects its own topbar button + palette DOM; no reliance on other
 * scripts' globals. Agent data comes from fetch() only. */
(function () {
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var NS = window.__symbiotePalette = window.__symbiotePalette || {};
  var els = null, open = false, items = [], selIdx = 0, cache = null, cacheAt = 0;

  var PAGES = [
    { name: 'Agents', sub: 'Directory of 101 agents', view: 'agents', ic: '◈' },
    { name: 'Custom Agents', sub: 'Build your own agents', view: 'customagents', ic: '✦' },
    { name: 'Dashboard', sub: 'Stats, analytics, recents', view: 'dashboard', ic: '▦' },
    { name: 'Dialer', sub: 'Dial by number', view: 'dialer', ic: '☎' },
    { name: 'Memory', sub: 'Call summaries & transcripts', view: 'memory', ic: '❋' },
    { name: 'Guide', sub: 'Guide center (docs)', href: 'docs.html', ic: '✎' },
    { name: 'Settings', sub: 'Key, theme, business line', view: 'settings', ic: '⚙' }
  ];

  var ACTIONS = [
    { name: 'New custom agent', sub: 'Open the builder', ic: '＋', run: actNewAgent },
    { name: 'Toggle theme', sub: 'Dark / light', ic: '◐', run: actTheme },
    { name: 'Replay tour', sub: '60-second guided tour', ic: '↻', run: actTour },
    { name: 'Focus mode', sub: 'Dim everything but the call', ic: '◎', run: actFocus }
  ];

  /* ---------- fuzzy match (subsequence, scored) ---------- */
  function fuzzy(q, text) {
    q = q.toLowerCase(); text = String(text).toLowerCase();
    if (!q) return { score: 1, idxs: [] };
    var ti = 0, idxs = [], score = 0, last = -2;
    for (var qi = 0; qi < q.length; qi++) {
      var c = q[qi], found = -1;
      for (var j = ti; j < text.length; j++) { if (text[j] === c) { found = j; break; } }
      if (found === -1) return null;
      idxs.push(found);
      score += (found === 0 ? 8 : 0) + (found === last + 1 ? 4 : 1);
      last = found; ti = found + 1;
    }
    return { score: score, idxs: idxs };
  }
  function mark(text, idxs) {
    var out = '', last = 0;
    idxs.forEach(function (i) {
      out += esc(text.slice(last, i)) + '<mark>' + esc(text[i]) + '</mark>';
      last = i + 1;
    });
    return out + esc(text.slice(last));
  }

  /* ---------- data ---------- */
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }
  function loadAgents() {
    var now = Date.now();
    if (cache && now - cacheAt < 5 * 60 * 1000) return Promise.resolve(cache);
    return Promise.all([
      getJSON('/api/agents').catch(function () { return { agents: [] }; }),
      getJSON('/api/v7/custom-agents').catch(function () { return { agents: [] }; })
    ]).then(function (res) {
      var list = [];
      (res[0].agents || []).forEach(function (a) {
        list.push({ kind: 'agent', name: a.name, sub: (a.niche || 'Agent') + ' · ' + (a.number || ''), ic: '◈', custom: false, agent: a });
      });
      (res[1].agents || []).forEach(function (a) {
        list.push({ kind: 'agent', name: a.name, sub: (a.role || 'Custom agent') + ' · ' + (a.number || ''), ic: '✦', custom: true, tag: 'custom', agent: a });
      });
      cache = list; cacheAt = now;
      return list;
    });
  }

  /* ---------- item assembly ---------- */
  function allItems(agents) {
    var out = [];
    agents.forEach(function (a) { out.push(a); });
    PAGES.forEach(function (p) { out.push({ kind: 'page', name: p.name, sub: p.sub, ic: p.ic, page: p }); });
    ACTIONS.forEach(function (a) { out.push({ kind: 'action', name: a.name, sub: a.sub, ic: a.ic, action: a }); });
    return out;
  }
  function filterItems(q) {
    var pool = allItems(cache || []);
    if (!q) return pool.slice(0, 60).map(function (it) { return { it: it, m: null }; });
    var scored = [];
    pool.forEach(function (it) {
      var m = fuzzy(q, it.name) || fuzzy(q, it.sub || '');
      if (m) scored.push({ it: it, m: m, s: m.score });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    return scored.slice(0, 60);
  }

  /* ---------- DOM ---------- */
  function buildDom() {
    if (els) return els;
    var veil = document.createElement('div'); veil.className = 'pal-veil'; veil.style.display = 'none';
    veil.innerHTML =
      '<div class="pal-panel" role="dialog" aria-label="Command palette">' +
      '<div class="pal-input-row">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '<input type="text" autocomplete="off" spellcheck="false" aria-label="Type to search agents, pages, actions">' +
      '<span class="pal-esc">esc</span></div>' +
      '<div class="pal-list" role="listbox"></div>' +
      '<div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> close</span></div>' +
      '</div>';
    document.body.appendChild(veil);
    var input = veil.querySelector('input'), list = veil.querySelector('.pal-list');
    input.addEventListener('input', function () { render(input.value.trim()); });
    input.addEventListener('keydown', onKey);
    veil.addEventListener('mousedown', function (e) { if (e.target === veil) close(); });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.pal-item');
      if (b) { runItem(items[+b.getAttribute('data-i')].it); }
    });
    list.addEventListener('mousemove', function (e) {
      var b = e.target.closest('.pal-item');
      if (b) setSel(+b.getAttribute('data-i'));
    });
    els = { veil: veil, input: input, list: list };
    return els;
  }

  function groupLabel(kind) {
    return kind === 'agent' ? 'Agents' : kind === 'page' ? 'Pages' : 'Actions';
  }

  function render(q) {
    var d = buildDom();
    var scored = filterItems(q);
    items = scored; selIdx = 0;
    var html = '', lastGroup = '';
    if (!scored.length) html = '<div class="pal-empty">No matches. Try an agent name, niche, or action.</div>';
    scored.forEach(function (s, i) {
      var g = groupLabel(s.it.kind);
      if (g !== lastGroup) { html += '<div class="pal-group">' + g + '</div>'; lastGroup = g; }
      var name = s.m ? mark(s.it.name, s.m.idxs) : esc(s.it.name);
      html += '<button type="button" role="option" class="pal-item' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
        '<span class="pi-ic">' + esc(s.it.ic) + '</span>' +
        '<span class="pi-main"><span class="pi-name">' + name + '</span>' +
        '<span class="pi-sub">' + esc(s.it.sub || '') + '</span></span>' +
        (s.it.tag ? '<span class="pi-tag">' + esc(s.it.tag) + '</span>' : '') +
        '</button>';
    });
    d.list.innerHTML = html;
  }

  function setSel(i) {
    if (!items.length) return;
    selIdx = (i + items.length) % items.length;
    var d = buildDom();
    var btns = d.list.querySelectorAll('.pal-item');
    Array.prototype.forEach.call(btns, function (b, j) {
      b.classList.toggle('sel', j === selIdx);
      if (j === selIdx && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
    });
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(selIdx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(selIdx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[selIdx]) runItem(items[selIdx].it); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  /* ---------- actions ---------- */
  function switchTab(view) {
    var btn = document.querySelector('#tabs [data-view="' + view + '"]');
    if (btn) btn.click();
  }
  function runItem(it) {
    close();
    setTimeout(function () {
      if (it.kind === 'page') {
        if (it.page.href) { window.location.href = it.page.href; return; }
        switchTab(it.page.view);
      } else if (it.kind === 'agent') {
        jumpToAgent(it);
      } else if (it.kind === 'action') {
        it.action.run();
      }
    }, 30);
  }
  function jumpToAgent(it) {
    var view = it.custom ? 'customagents' : 'agents';
    switchTab(view);
    setTimeout(function () {
      if (!it.custom) {
        var s = document.querySelector('#agentGrid .dir-search, .dir-search');
        if (s) {
          s.value = it.name;
          s.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      var grid = document.getElementById('agentGrid') || document.getElementById('customAgentsRoot');
      if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);
  }
  function actNewAgent() {
    switchTab('customagents');
    setTimeout(function () {
      var btn = document.querySelector('#customAgentsRoot .ca-btn-primary, button.ca-btn-primary');
      if (btn) btn.click();
    }, 300);
  }
  function actTheme() {
    var t = document.getElementById('themeToggle');
    if (t) t.click(); /* reuse the app's own theme logic */
  }
  function actTour() {
    if (window.__symbioteTour && window.__symbioteTour.replay) window.__symbioteTour.replay();
  }
  function actFocus() {
    var on = document.body.classList.toggle('focus-mode');
    document.dispatchEvent(new CustomEvent('symbiote:focus-mode', { detail: { on: on } }));
  }

  /* ---------- open / close ---------- */
  function openPal() {
    if (!document.getElementById('tabs')) return; /* index page only */
    if (document.body.classList.contains('kg-gated')) return; /* not before login */
    var d = buildDom();
    open = true;
    d.veil.style.display = 'flex';
    d.input.value = '';
    loadAgents().then(function () { render(''); });
    render('');
    setTimeout(function () { d.input.focus(); }, 20);
  }
  function close() {
    if (!open) return;
    open = false;
    buildDom().veil.style.display = 'none';
  }
  function toggle() { open ? close() : openPal(); }

  /* ---------- topbar button ---------- */
  function injectButton() {
    if (!document.getElementById('tabs')) return;
    if (document.getElementById('palTopBtn')) return;
    var themeBtn = document.getElementById('themeToggle');
    if (!themeBtn || !themeBtn.parentNode) return;
    var b = document.createElement('button');
    b.type = 'button'; b.id = 'palTopBtn'; b.className = 'pal-topbtn';
    b.setAttribute('aria-label', 'Open command palette (Ctrl+K)');
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>' +
      '<span class="pal-label">Search</span><kbd>Ctrl K</kbd>';
    b.addEventListener('click', toggle);
    themeBtn.parentNode.insertBefore(b, themeBtn);
  }

  NS.open = openPal; NS.close = close; NS.toggle = toggle;
  NS.refreshAgents = function () { cache = null; return loadAgents(); };

  ready(function () {
    injectButton();
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape' && open) {
        close();
      }
    });
  });
})();
