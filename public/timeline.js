'use strict';
/* public/timeline.js — v8.0.0 W4: call timeline UI (#42).
 *
 * A beautiful, filterable (by agent, by date) timeline of calls, rendered
 * into the dashboard area (#view-dashboard) from the existing
 * GET /api/history endpoint (history rows are
 * { id, agentId, agentName, number, startedAt, endedAt, durationSec, outcome }).
 * Self-initializes on DOMContentLoaded; coexists with app.js's #statsRow /
 * #dashRecents rendering and with window.DashLayout (analytics.js) for
 * drag-reorder support.
 *
 * INTEGRATOR CONTRACT (for the coordinator wiring index.html):
 *   <script src="analytics.js"></script>
 *   <script src="timeline.js"></script>
 * after app.js. Exposes window.CallTimeline.
 */
(function (global) {

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

  /* ---------- pure logic (node-testable) ---------- */

  // dayKey(ts) -> local 'YYYY-MM-DD' for a timestamp. Pure.
  function dayKey(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // dayLabel(key) -> 'Today' | 'Yesterday' | 'Mon, Oct 12'. Pure.
  function dayLabel(key) {
    if (!key) return 'Unknown date';
    var today = dayKey(Date.now());
    if (key === today) return 'Today';
    var y = new Date(Date.now() - 86400000);
    if (key === dayKey(y.getTime())) return 'Yesterday';
    var parts = key.split('-');
    if (parts.length === 3) {
      var d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      if (!isNaN(d.getTime())) {
        var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
      }
    }
    return key;
  }

  // filterCalls(calls, f) — f = { agentId: '' | id, date: '' | 'YYYY-MM-DD' }.
  // Pure; returns newest-first.
  function filterCalls(calls, f) {
    f = f || {};
    var agentId = String(f.agentId || '');
    var date = String(f.date || '');
    var rows = (Array.isArray(calls) ? calls : []).filter(function (c) {
      if (!c || typeof c !== 'object') return false;
      if (agentId && String(c.agentId || '') !== agentId) return false;
      if (date && dayKey(c.startedAt) !== date) return false;
      return true;
    });
    rows.sort(function (a, b) {
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    });
    return rows;
  }

  // groupByDay(calls) -> [{ key, label, items }] newest day first. Pure.
  function groupByDay(calls) {
    var groups = {}, order = [];
    (Array.isArray(calls) ? calls : []).forEach(function (c) {
      var k = dayKey(c && c.startedAt) || 'unknown';
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(c);
    });
    order.sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); });
    return order.map(function (k) {
      return { key: k, label: k === 'unknown' ? 'Unknown date' : dayLabel(k), items: groups[k] };
    });
  }

  // agentOptions(calls) -> [{ id, name }] unique agents, name-sorted. Pure.
  function agentOptions(calls) {
    var seen = {};
    (Array.isArray(calls) ? calls : []).forEach(function (c) {
      if (!c) return;
      var id = String(c.agentId || '');
      if (!id || seen[id]) return;
      seen[id] = { id: id, name: String(c.agentName || id) };
    });
    return Object.keys(seen).map(function (k) { return seen[k]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    var h = d.getHours(), m = d.getMinutes(), ap = h < 12 ? 'am' : 'pm';
    var hr = h % 12; if (hr === 0) hr = 12;
    return hr + ':' + (m < 10 ? '0' : '') + m + ap;
  }

  function fmtDurShort(secs) {
    secs = Math.max(0, Math.round(Number(secs) || 0));
    if (secs < 60) return secs + 's';
    var m = Math.floor(secs / 60), s = secs % 60;
    return s ? m + 'm ' + s + 's' : m + 'm';
  }

  /* ---------- DOM rendering ---------- */

  var filterState = { agentId: '', date: '' };
  var allCalls = [];

  function outcomeClass(outcome) {
    var o = String(outcome || '').toLowerCase();
    if (/complete|success|answered|connected/.test(o)) return 'ok';
    if (/miss|fail|error|busy|decline|cancel/.test(o)) return 'bad';
    return 'muted';
  }

  function renderList(box) {
    box.innerHTML = '';
    var rows = filterCalls(allCalls, filterState);
    if (!rows.length) {
      box.appendChild(el('p', 'dash-empty dim',
        allCalls.length ? 'No calls match these filters.' : 'No calls yet — your call history will appear here.'));
      return;
    }
    groupByDay(rows).forEach(function (g) {
      var day = el('div', 'tl-day');
      day.appendChild(el('div', 'tl-day-lbl', g.label));
      var items = el('div', 'tl-items');
      g.items.forEach(function (c) {
        var it = el('div', 'tl-item');
        it.appendChild(el('span', 'tl-dot ' + outcomeClass(c.outcome || c.status)));
        var card = el('div', 'tl-card');
        var top = el('div', 'tl-top');
        top.appendChild(el('div', 'tl-name', String(c.agentName || c.agentId || 'Unknown')));
        top.appendChild(el('div', 'tl-time tiny dim', fmtTime(c.startedAt)));
        card.appendChild(top);
        var meta = el('div', 'tl-meta tiny dim');
        var bits = [];
        if (c.number) bits.push(String(c.number));
        if (c.durationSec != null) bits.push(fmtDurShort(c.durationSec));
        if (c.outcome || c.status) bits.push(String(c.outcome || c.status));
        meta.textContent = bits.join(' · ');
        card.appendChild(meta);
        it.appendChild(card);
        items.appendChild(it);
      });
      day.appendChild(items);
      box.appendChild(day);
    });
  }

  function renderFilters(sec, box) {
    var bar = el('div', 'tl-filters');

    var agentSel = el('select', 'tl-select');
    agentSel.setAttribute('aria-label', 'Filter by agent');
    agentSel.appendChild(el('option', null, 'All agents'));
    agentSel.firstChild.value = '';
    agentOptions(allCalls).forEach(function (o) {
      var opt = el('option', null, o.name);
      opt.value = o.id;
      agentSel.appendChild(opt);
    });
    agentSel.value = filterState.agentId;
    agentSel.addEventListener('change', function () {
      filterState.agentId = agentSel.value;
      renderList(box);
    });
    bar.appendChild(agentSel);

    var dateIn = el('input', 'tl-date');
    dateIn.type = 'date';
    dateIn.setAttribute('aria-label', 'Filter by date');
    dateIn.value = filterState.date;
    dateIn.addEventListener('change', function () {
      filterState.date = dateIn.value;
      renderList(box);
    });
    bar.appendChild(dateIn);

    var clear = el('button', 'btn ghost tl-clear', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      filterState.agentId = ''; filterState.date = '';
      agentSel.value = ''; dateIn.value = '';
      renderList(box);
    });
    bar.appendChild(clear);

    var old = sec.querySelector('.tl-filters');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var title = sec.querySelector('.dash-sec-title');
    if (title && title.parentNode) title.parentNode.insertBefore(bar, title.nextSibling);
    else sec.insertBefore(bar, sec.firstChild);
  }

  function loadTimeline(sec) {
    apiFetchLocal('api/history').then(function (r) {
      if (!r || !r.ok) throw new Error('http ' + (r && r.status));
      return r.json();
    }).then(function (j) {
      allCalls = (j && (j.calls || j)) || [];
      if (!Array.isArray(allCalls)) allCalls = [];
      var box = sec.querySelector('.tl-list');
      renderFilters(sec, box);
      renderList(box);
      if (global.DashLayout && typeof global.DashLayout.tagAll === 'function') global.DashLayout.tagAll();
    }).catch(function () {
      var box = sec.querySelector('.tl-list');
      if (box) box.appendChild(el('p', 'dash-empty dim', 'Could not load call history.'));
    });
  }

  function mountTimeline() {
    if (!isBrowser()) return;
    var root = document.getElementById('view-dashboard');
    if (!root) return;
    var sec = root.querySelector('[data-dash-id="timeline"]');
    if (!sec) {
      sec = el('section', 'dash-timeline');
      sec.setAttribute('data-dash-id', 'timeline');
      root.appendChild(sec);
    }
    sec.innerHTML = '';
    sec.appendChild(el('h3', 'dash-sec-title', 'Call timeline'));
    sec.appendChild(el('div', 'tl-list'));
    loadTimeline(sec);
  }

  var CallTimeline = {
    dayKey: dayKey,
    dayLabel: dayLabel,
    filterCalls: filterCalls,
    groupByDay: groupByDay,
    agentOptions: agentOptions,
    reload: function () {
      if (!isBrowser()) return;
      var sec = document.querySelector('[data-dash-id="timeline"]');
      if (sec) loadTimeline(sec);
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports.CallTimeline = CallTimeline;
  global.CallTimeline = CallTimeline;

  if (isBrowser()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountTimeline);
    } else {
      mountTimeline();
    }
  }

})((typeof window !== 'undefined') ? window : global);
