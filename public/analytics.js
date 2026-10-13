'use strict';
/* public/analytics.js — v8.0.0 W4.
 *
 * Two dashboard workstreams in one file:
 *
 *   #4-frontend  Analytics widgets in the Dashboard: per-agent totals, avg
 *                call duration, busy-hours bar chart. Data comes from
 *                GET /api/v8/analytics (a backend worker implements it):
 *                  { agents: [{ agentId, name, calls, avgSecs, byHour: [24] }],
 *                    totals: { calls, minutes } }
 *                If the endpoint 404s or fails, a graceful empty state is
 *                rendered — data is never invented client-side.
 *                Exposes window.DashAnalytics.
 *
 *   #43          Customizable dashboard: dashboard cards/sections are
 *                drag-droppable to reorder (pointer-based, touch-friendly).
 *                Layout persists per API key in localStorage.
 *                Exposes window.DashLayout.
 *
 * INTEGRATOR CONTRACT (for the coordinator wiring index.html):
 *   <script src="analytics.js"></script>
 *   <script src="timeline.js"></script>
 * after app.js. Both self-initialize on DOMContentLoaded and render into
 * #view-dashboard via DOM; they coexist with app.js's own #statsRow /
 * #dashRecents rendering (they never clear those mounts).
 */
(function (global) {

  /* ---------- shared helpers ---------- */
  function isBrowser() { return typeof document !== 'undefined'; }
  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function apiFetchLocal(u) {
    try {
      if (global.KeyGate && typeof global.KeyGate.apiFetch === 'function') return global.KeyGate.apiFetch(u);
    } catch (e) {}
    return fetch(u);
  }

  /* ================= #4-frontend: analytics widgets ================= */

  // normalizeAnalytics(payload) -> { agents:[{agentId,name,calls,avgSecs,byHour[24]}],
  //   totals:{calls,minutes} } or null when the payload is unusable. Pure.
  function normalizeAnalytics(payload) {
    if (!payload || typeof payload !== 'object') return null;
    var rawAgents = Array.isArray(payload.agents) ? payload.agents : [];
    var rawTotals = (payload.totals && typeof payload.totals === 'object') ? payload.totals : {};
    var agents = rawAgents.map(function (a) {
      a = a || {};
      var byHour = Array.isArray(a.byHour) ? a.byHour.slice(0, 24) : [];
      while (byHour.length < 24) byHour.push(0);
      return {
        agentId: String(a.agentId == null ? '' : a.agentId),
        name: String(a.name || a.agentId || 'Unknown'),
        calls: Math.max(0, Number(a.calls) || 0),
        avgSecs: Math.max(0, Number(a.avgSecs) || 0),
        byHour: byHour.map(function (x) { return Math.max(0, Number(x) || 0); })
      };
    });
    agents.sort(function (a, b) { return b.calls - a.calls; });
    return {
      agents: agents,
      totals: {
        calls: Math.max(0, Number(rawTotals.calls) || 0),
        minutes: Math.max(0, Number(rawTotals.minutes) || 0)
      }
    };
  }

  // busyHours(agents) -> [24] totals per hour across agents. Pure.
  function busyHours(agents) {
    var h = [];
    for (var i = 0; i < 24; i++) h.push(0);
    (Array.isArray(agents) ? agents : []).forEach(function (a) {
      (a.byHour || []).forEach(function (v, i) { if (i < 24) h[i] += (Number(v) || 0); });
    });
    return h;
  }

  // fmtDur(secs) -> "m:ss". Pure.
  function fmtDur(secs) {
    secs = Math.max(0, Math.round(Number(secs) || 0));
    var m = Math.floor(secs / 60), s = secs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function hourLabel(h) {
    h = ((Number(h) % 24) + 24) % 24;
    var ap = h < 12 ? 'am' : 'pm';
    var hr = h % 12; if (hr === 0) hr = 12;
    return hr + ap;
  }

  function renderAnalyticsSection(sec, data) {
    sec.innerHTML = '';
    sec.appendChild(el('h3', 'dash-sec-title', 'Call analytics'));

    var hours = busyHours(data.agents);
    var peak = 0;
    hours.forEach(function (v, i) { if (v > hours[peak]) peak = i; });
    var avgPerCall = data.totals.calls
      ? Math.round((data.totals.minutes * 60) / data.totals.calls) : 0;

    var sum = el('div', 'anl-summary');
    [['Total calls', String(data.totals.calls)],
     ['Total minutes', String(data.totals.minutes)],
     ['Avg / call', fmtDur(avgPerCall)],
     ['Busiest hour', data.totals.calls ? hourLabel(peak) : '—']].forEach(function (s) {
      var c = el('div', 'anl-sum-card');
      c.appendChild(el('div', 'anl-sum-num', s[1]));
      c.appendChild(el('div', 'anl-sum-lbl', s[0]));
      sum.appendChild(c);
    });
    sec.appendChild(sum);

    if (data.agents.length) {
      sec.appendChild(el('h4', 'dash-sub-title', 'Per-agent totals'));
      var list = el('div', 'anl-agents');
      data.agents.slice(0, 8).forEach(function (a) {
        var r = el('div', 'anl-agent-row');
        var nm = el('div', 'anl-agent-name', a.name);
        var meta = el('div', 'anl-agent-meta tiny dim',
          a.calls + (a.calls === 1 ? ' call' : ' calls') + ' · avg ' + fmtDur(a.avgSecs));
        var left = el('div', 'anl-agent-left');
        left.appendChild(nm); left.appendChild(meta);
        r.appendChild(left);
        var bar = el('div', 'anl-agent-bar');
        var fill = el('div', 'anl-agent-fill');
        var top = data.agents[0].calls || 1;
        fill.style.width = Math.max(4, Math.round((a.calls / top) * 100)) + '%';
        bar.appendChild(fill);
        r.appendChild(bar);
        list.appendChild(r);
      });
      sec.appendChild(list);
    }

    sec.appendChild(el('h4', 'dash-sub-title', 'Busy hours'));
    var chart = el('div', 'anl-chart');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', 'Calls per hour of day');
    var max = Math.max.apply(null, hours.concat([1]));
    hours.forEach(function (v, i) {
      var col = el('div', 'anl-col' + (i === peak && data.totals.calls ? ' peak' : ''));
      var b = el('div', 'anl-bar');
      b.style.height = Math.max(3, Math.round((v / max) * 100)) + '%';
      b.title = hourLabel(i) + ' — ' + v + (v === 1 ? ' call' : ' calls');
      col.appendChild(b);
      col.appendChild(el('div', 'anl-hlbl tiny', i % 3 === 0 ? hourLabel(i) : ''));
      chart.appendChild(col);
    });
    sec.appendChild(chart);
  }

  function renderAnalyticsEmpty(sec, msg) {
    sec.innerHTML = '';
    sec.appendChild(el('h3', 'dash-sec-title', 'Call analytics'));
    sec.appendChild(el('p', 'dash-empty dim', msg));
  }

  function loadAnalytics(sec) {
    apiFetchLocal('api/v8/analytics').then(function (r) {
      if (!r || !r.ok) throw new Error('http ' + (r && r.status));
      return r.json();
    }).then(function (j) {
      var d = normalizeAnalytics(j);
      if (!d || !d.totals.calls) {
        renderAnalyticsEmpty(sec, 'No call data yet — make a call and analytics will appear here.');
      } else {
        renderAnalyticsSection(sec, d);
      }
    }).catch(function () {
      // Backend worker implements /api/v8/analytics; until then, empty state.
      renderAnalyticsEmpty(sec,
        'Analytics are not available yet — the server endpoint is still being rolled out.');
    });
  }

  var DashAnalytics = {
    normalizeAnalytics: normalizeAnalytics,
    busyHours: busyHours,
    fmtDur: fmtDur,
    hourLabel: hourLabel,
    reload: function () {
      if (!isBrowser()) return;
      var sec = document.querySelector('[data-dash-id="analytics"]');
      if (sec) loadAnalytics(sec);
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports.DashAnalytics = DashAnalytics;
  global.DashAnalytics = DashAnalytics;

  /* ================= #43: customizable dashboard layout ================= */

  var DashLayout = (function () {
    var LS_PREFIX = 'sym-v8-dash-';
    var inited = false;

    function dashRoot() { return document.getElementById('view-dashboard'); }

    // Stable ids for dashboard blocks (existing + v8). view-head stays fixed.
    function ensureId(block) {
      if (block.getAttribute('data-dash-id')) return block.getAttribute('data-dash-id');
      var id = block.id || '';
      var map = { statsRow: 'stats', dashRecents: 'recents' };
      var dashId = map[id] ||
        (block.tagName === 'H3' ? 'h3-' + String(block.textContent || '').trim().slice(0, 20).replace(/\W+/g, '-').toLowerCase()
                                : 'block-' + Math.random().toString(36).slice(2, 8));
      block.setAttribute('data-dash-id', dashId);
      return dashId;
    }

    function blocks() {
      var root = dashRoot();
      if (!root) return [];
      return Array.prototype.filter.call(root.children, function (c) {
        return !c.classList.contains('view-head');
      });
    }

    function currentKeyHashSync() {
      try {
        if (global.KeyGate && global.KeyGate._keyHash) return String(global.KeyGate._keyHash);
      } catch (e) {}
      return null;
    }
    function storageKey(kh) { return LS_PREFIX + (kh || 'shared'); }
    function readOrder(kh) {
      try {
        var raw = localStorage.getItem(storageKey(kh));
        var arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.map(String) : [];
      } catch (e) { return []; }
    }
    function saveOrder(kh) {
      try {
        var ids = blocks().map(function (b) { return ensureId(b); });
        localStorage.setItem(storageKey(kh), JSON.stringify(ids));
      } catch (e) {}
    }
    function applyOrder(kh) {
      var root = dashRoot();
      if (!root) return;
      var order = readOrder(kh);
      if (!order.length) return;
      var byId = {};
      blocks().forEach(function (b) { byId[ensureId(b)] = b; });
      order.forEach(function (id) {
        var b = byId[id];
        if (b) root.appendChild(b); // append in saved order; unknown blocks keep place
        delete byId[id];
      });
    }

    function addHandle(block) {
      if (block.querySelector(':scope > .dash-grip')) return;
      block.classList.add('dash-block');
      var grip = el('button', 'dash-grip');
      grip.type = 'button';
      grip.title = 'Drag to reorder';
      grip.setAttribute('aria-label', 'Drag to reorder dashboard section');
      grip.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">' +
        '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
        '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
        '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
      grip.addEventListener('pointerdown', function (e) { startDrag(e, block); });
      block.appendChild(grip);
    }

    function startDrag(e, block) {
      e.preventDefault();
      var root = dashRoot();
      if (!root) return;
      var startY = (e.clientY != null ? e.clientY : 0);
      block.classList.add('dragging');
      var moved = false;
      try { e.target.setPointerCapture && e.target.setPointerCapture(e.pointerId); } catch (err) {}

      function onMove(ev) {
        var y = ev.clientY != null ? ev.clientY : startY;
        block.style.transform = 'translateY(' + (y - startY) + 'px)';
        var others = blocks().filter(function (b) { return b !== block; });
        var target = null;
        for (var i = 0; i < others.length; i++) {
          var r = others[i].getBoundingClientRect();
          if (y < r.top + r.height / 2) { target = others[i]; break; }
        }
        if (target) root.insertBefore(block, target);
        else root.appendChild(block);
        moved = true;
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        block.classList.remove('dragging');
        block.style.transform = '';
        if (moved) {
          var kh = currentKeyHashSync();
          saveOrder(kh);
          // Re-resolve async (key may have just switched); apply latest saved.
          try {
            if (global.KeyGate && typeof global.KeyGate.getKeyHash === 'function') {
              global.KeyGate.getKeyHash().then(function (akh) { saveOrder(akh); }).catch(function () {});
            }
          } catch (err) {}
        }
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }

    function tagAll() {
      blocks().forEach(function (b) { ensureId(b); addHandle(b); });
    }

    function init() {
      if (!isBrowser() || !dashRoot()) return;
      tagAll();
      applyOrder(currentKeyHashSync());
      try {
        if (global.KeyGate && typeof global.KeyGate.getKeyHash === 'function') {
          global.KeyGate.getKeyHash().then(function (kh) { applyOrder(kh); }).catch(function () {});
        }
      } catch (e) {}
      if (inited) return;
      inited = true;
      // Catch blocks mounted later (e.g. timeline.js loading after analytics.js).
      try {
        var mo = new MutationObserver(function () { tagAll(); });
        mo.observe(dashRoot(), { childList: true });
      } catch (e) {}
    }

    return {
      init: init,
      tagAll: tagAll,
      applyOrder: applyOrder,
      _storageKey: storageKey,
      _readOrder: readOrder
    };
  })();
  global.DashLayout = DashLayout;
  if (typeof module !== 'undefined' && module.exports) module.exports.DashLayout = DashLayout;

  /* ---------- self-init ---------- */
  function mountAnalytics() {
    if (!isBrowser()) return;
    var root = document.getElementById('view-dashboard');
    if (!root) return;
    var sec = root.querySelector('[data-dash-id="analytics"]');
    if (!sec) {
      sec = el('section', 'dash-analytics');
      sec.setAttribute('data-dash-id', 'analytics');
      root.appendChild(sec);
    }
    loadAnalytics(sec);
  }

  if (isBrowser()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        mountAnalytics();
        DashLayout.init();
      });
    } else {
      mountAnalytics();
      DashLayout.init();
    }
  }

})((typeof window !== 'undefined') ? window : global);
