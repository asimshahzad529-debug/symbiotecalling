'use strict';
/**
 * public/custom-agents.js — v7 custom agent builder UI (WS2).
 *
 * window.CustomAgents.renderPage(container) — full page: list + builder form.
 * API via window.KeyGate.apiFetch when present (key-gating workstream),
 * else plain fetch. No API key ever goes into URLs.
 *
 * Exposed for other v7 modules (directory/dialer/history/stats merge):
 *   window.CustomAgents.mergeAgentLists(builtinList, customList)
 *   window.CustomAgents.fetchCustomAgents() -> Promise<[publicCustomAgent]>
 *   window.CustomAgents.avatarUrlFor(agent)   // v7.5: always null — default avatar only
 *   window.CustomAgents.PROMPT_TEMPLATES
 */

(function () {
  var API = '/api/v7/custom-agents';
  var TONES = ['professional', 'friendly', 'confident', 'casual'];

  // v7 WS7 adapter: directory.js profileSheet calls
  // window.CustomAgents.cloneFrom(agent) with a built-in agent object.
  // Custom agents are never cloneable — this is rejected here, at the
  // button level, and server-side. We fetch a pre-filled draft from the
  // clone API, stash it, and ask app.js (via event) to open the Custom
  // Agents page — renderPage() picks the draft up and opens the builder
  // form with it.
  var pendingDraft = null;

  function cloneFrom(agent) {
    var sid = agent && (agent.id || agent.sourceId);
    if (!sid) {
      try { alert('Clone failed: no source agent'); } catch (e) {}
      return;
    }
    if (agent.isCustom === true || (typeof sid === 'string' && sid.indexOf('custom_') === 0)) {
      try { alert('Custom agents cannot be cloned'); } catch (e) {}
      return;
    }
    api(API + '/clone', 'POST', { sourceId: sid }).then(function (j) {
      pendingDraft = (j && j.draft) || null;
      try { window.dispatchEvent(new CustomEvent('customagents:open-builder')); } catch (e) {}
    }).catch(function (e) {
      try { alert('Clone failed: ' + e.message); } catch (e2) {}
    });
  }

  var PROMPT_TEMPLATES = {
    'Sales rep': 'You are a sales representative. Qualify the caller: ask about their need, budget, and timeline — one question at a time. Handle objections (price, timing, trust) calmly and honestly. Never pressure; never invent offers or discounts you cannot verify.',
    'Receptionist': 'You are a front-desk receptionist. Greet callers warmly and route their request: ask what they need — one question at a time — then help with scheduling, directions, or general information. Keep it efficient and polite.',
    'Support': 'You are a customer-support agent. Listen to the problem, ask clarifying questions one at a time, and walk through safe troubleshooting steps. If you cannot resolve it, summarize what you learned and say a specialist will follow up.'
  };

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function apiFetch(path, opts) {
    opts = opts || {};
    if (window.KeyGate && typeof window.KeyGate.apiFetch === 'function') {
      return window.KeyGate.apiFetch(path, opts);
    }
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: opts.body });
  }

  function api(path, method, body) {
    return apiFetch(path, { method: method, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || ('request failed: ' + r.status));
          return j;
        });
      });
  }

  function fetchCustomAgents() {
    return api(API, 'GET').then(function (j) { return j.agents || []; });
  }

  /**
   * v7.5 reactivity: after a custom agent is created/updated/deleted, tell
   * the rest of the app (Agents list + dialer) to re-merge the directory for
   * the active key — no page reload. No-op when custom-events.js isn't loaded.
   */
  function notifyChanged(action, id) {
    try {
      if (typeof window !== 'undefined' && window.CustomAgentEvents &&
          typeof window.CustomAgentEvents.emitChanged === 'function') {
        window.CustomAgentEvents.emitChanged({ action: action, id: id || null });
      }
    } catch (e) { /* notification is best-effort */ }
  }

  // v7.5: avatar upload was removed — every custom agent uses the default
  // phone-caller avatar. Kept as a null-returning stub so external callers
  // don't break.
  function avatarUrlFor(agent) {
    return null;
  }

  /**
   * mergeAgentLists(builtinList, customList) — directory/dialer/history/stats
   * rendering merge: built-ins first, then customs; customs carry a "Custom"
   * badge and always the default avatar.
   */
  function mergeAgentLists(builtinList, customList) {
    var out = (builtinList || []).slice();
    (customList || []).forEach(function (c) {
      var a = {
        id: c.id, name: c.name, niche: c.role || c.niche, number: c.number,
        voice: c.voice, tagline: c.role || '', color: '#7c3aed',
        isCustom: true, hasAvatarUpload: false,
        avatarUrl: null, customBadge: 'Custom'
      };
      out.push(a);
    });
    return out;
  }

  // ---------------- builder form ----------------
  function buildForm(container, existing, voices, onSaved, onCancel) {
    var form = el('div', 'ca-form');
    var editing = !!existing;

    function field(labelText, inputEl, hint) {
      var w = el('div', 'ca-field');
      var lab = el('label', '', labelText);
      w.appendChild(lab); w.appendChild(inputEl);
      if (hint) w.appendChild(el('div', 'ca-hint', hint));
      return w;
    }

    var nameI = document.createElement('input');
    nameI.type = 'text'; nameI.maxLength = 60; nameI.placeholder = 'e.g. Zara Khan';
    nameI.value = existing ? existing.name : '';
    var numI = document.createElement('input');
    numI.type = 'text'; numI.maxLength = 24; numI.placeholder = 'any number, kept as typed';
    numI.value = existing ? existing.number : '';
    var roleI = document.createElement('input');
    roleI.type = 'text'; roleI.maxLength = 120; roleI.placeholder = 'e.g. Real estate advisor';
    roleI.value = existing ? existing.role : '';
    var toneS = document.createElement('select');
    TONES.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t; o.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      if (existing && existing.tone === t) o.selected = true;
      toneS.appendChild(o);
    });
    var voiceS = document.createElement('select');
    (voices.length ? voices : ['Charon']).forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (existing && existing.voice === v) o.selected = true;
      voiceS.appendChild(o);
    });
    var promptT = document.createElement('textarea');
    promptT.rows = 6; promptT.maxLength = 4000;
    promptT.placeholder = 'Optional: extra instructions for this agent…';
    promptT.value = existing ? (existing.prompt || '') : '';

    var tplRow = el('div', 'ca-templates');
    Object.keys(PROMPT_TEMPLATES).forEach(function (name) {
      var b = el('button', 'ca-chip', name);
      b.type = 'button';
      b.addEventListener('click', function () {
        promptT.value = PROMPT_TEMPLATES[name];
        promptT.focus();
      });
      tplRow.appendChild(b);
    });

    var err = el('div', 'ca-error'); err.style.display = 'none';
    var saveBtn = el('button', 'ca-btn ca-btn-primary', editing ? 'Save changes' : 'Create agent');
    var cancelBtn = el('button', 'ca-btn', 'Cancel');
    var btnRow = el('div', 'ca-form-btns');
    btnRow.appendChild(saveBtn); btnRow.appendChild(cancelBtn);

    form.appendChild(el('h3', 'ca-form-title', editing ? 'Edit agent' : 'New custom agent'));
    form.appendChild(field('Name *', nameI));
    form.appendChild(field('Phone number *', numI, 'Any number — kept exactly as you type it.'));
    form.appendChild(field('Role *', roleI, 'What this agent does (shown as its specialty).'));
    form.appendChild(field('Tone', toneS));
    form.appendChild(field('Voice', voiceS));
    var pw = field('Prompt (optional)', promptT, 'Extra behavior instructions, up to 4000 characters.');
    form.appendChild(pw);
    form.appendChild(tplRow);
    form.appendChild(err);
    form.appendChild(btnRow);

    function showError(m) { err.textContent = m; err.style.display = ''; }

    saveBtn.addEventListener('click', function () {
      var payload = {
        name: nameI.value.trim(),
        number: numI.value.trim(),
        role: roleI.value.trim(),
        tone: toneS.value,
        voice: voiceS.value,
        prompt: promptT.value
      };
      if (!payload.name) return showError('Name is required.');
      if (!payload.number) return showError('Number is required.');
      if (!payload.role) return showError('Role is required.');
      saveBtn.disabled = true;
      var p = editing
        ? api(API + '/' + encodeURIComponent(existing.id), 'PUT', payload)
        : api(API, 'POST', payload);
      p.then(function (j) {
        notifyChanged(editing ? 'updated' : 'created', j.agent && j.agent.id);
        onSaved(j.agent);
      })
        .catch(function (e) { showError(e.message); saveBtn.disabled = false; });
    });
    cancelBtn.addEventListener('click', onCancel);

    container.appendChild(form);
  }

  // ---------------- page ----------------
  function renderPage(container) {
    container.innerHTML = '';
    var root = el('div', 'ca-page');
    var head = el('div', 'ca-head');
    head.appendChild(el('h2', 'ca-title', 'Custom Agents'));
    head.appendChild(el('p', 'ca-sub', 'Your own voice agents — they work exactly like built-in agents.'));
    var newBtn = el('button', 'ca-btn ca-btn-primary', '+ New agent');
    head.appendChild(newBtn);
    var cloneSel = document.createElement('select');
    cloneSel.className = 'ca-clone-select';
    var cloneOpt = document.createElement('option');
    cloneOpt.value = ''; cloneOpt.textContent = 'Clone a built-in agent…';
    cloneSel.appendChild(cloneOpt);
    head.appendChild(cloneSel);
    root.appendChild(head);
    var listEl = el('div', 'ca-list');
    root.appendChild(listEl);
    var formHost = el('div', 'ca-form-host');
    root.appendChild(formHost);
    container.appendChild(root);

    var voices = [];
    var agents = [];

    function voicesFromDirectory() {
      return apiFetch('/api/agents', { method: 'GET' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          var seen = {};
          (j.agents || []).forEach(function (a) {
            if (a.voice) seen[a.voice] = 1;
            var o = document.createElement('option');
            o.value = a.id; o.textContent = a.name + ' — ' + (a.niche || '');
            cloneSel.appendChild(o);
          });
          return Object.keys(seen).sort();
        })
        .catch(function () { return []; });
    }

    cloneSel.addEventListener('change', function () {
      var sid = cloneSel.value;
      if (!sid) return;
      cloneSel.value = '';
      api(API + '/clone', 'POST', { sourceId: sid }).then(function (j) {
        openForm(null, j.draft);
      }).catch(function (e) { alert('Clone failed: ' + e.message); });
    });

    // v7.5: avatar upload removed — every custom agent shows the default
    // phone-caller avatar.
    function avatarFor(a) {
      return '<span class="ca-row-avatar ca-row-avatar-default"></span>';
    }

    function renderList() {
      listEl.innerHTML = '';
      if (!agents.length) {
        listEl.appendChild(el('div', 'ca-empty', 'No custom agents yet — create your first one.'));
        return;
      }
      agents.forEach(function (a) {
        var card = el('div', 'ca-card');
        card.innerHTML =
          '<div class="ca-card-main">' + avatarFor(a) +
          '<div class="ca-card-text"><div class="ca-card-name">' + esc(a.name) +
          ' <span class="ca-badge">Custom</span></div>' +
          '<div class="ca-card-meta">' + esc(a.role || '') + ' · ' + esc(a.number) +
          ' · ' + esc(a.tone || 'professional') + ' · ' + esc(a.voice || '') + '</div></div></div>' +
          '<div class="ca-card-actions"></div>';
        var actions = card.querySelector('.ca-card-actions');
        var bEdit = el('button', 'ca-btn ca-btn-sm', 'Edit');
        // No Clone button here: custom agents are not cloneable, by anyone.
        var bDel = el('button', 'ca-btn ca-btn-sm ca-btn-danger', 'Delete');
        bEdit.addEventListener('click', function () { openForm(a); });
        bDel.addEventListener('click', function () {
          if (!confirm('Delete "' + a.name + '"?')) return;
          api(API + '/' + encodeURIComponent(a.id), 'DELETE').then(function () {
            notifyChanged('deleted', a.id);
            refresh();
          }).catch(function (e) {
            alert('Delete failed: ' + e.message);
          });
        });
        actions.appendChild(bEdit); actions.appendChild(bDel);
        listEl.appendChild(card);
      });
    }

    function openForm(existing, draft) {
      formHost.innerHTML = '';
      var seed = existing || (draft ? {
        name: draft.name, number: draft.number, role: draft.role,
        tone: draft.tone, voice: draft.voice, prompt: draft.prompt
      } : null);
      buildForm(formHost, seed, voices, function () {
        formHost.innerHTML = '';
        refresh();
      }, function () { formHost.innerHTML = ''; });
      formHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function refresh() {
      fetchCustomAgents().then(function (list) {
        agents = list;
        renderList();
      }).catch(function (e) {
        listEl.innerHTML = '';
        listEl.appendChild(el('div', 'ca-error', 'Could not load custom agents: ' + e.message));
      });
    }

    newBtn.addEventListener('click', function () { openForm(null, null); });
    voicesFromDirectory().then(function (v) { voices = v; });
    refresh();
    // WS7 adapter: a clone draft stashed by cloneFrom() opens the builder
    // form as soon as the page renders.
    if (pendingDraft) {
      var draft = pendingDraft;
      pendingDraft = null;
      openForm(null, draft);
    }
  }

  var CustomAgentsApi = {
    renderPage: renderPage,
    fetchCustomAgents: fetchCustomAgents,
    mergeAgentLists: mergeAgentLists,
    avatarUrlFor: avatarUrlFor,
    cloneFrom: cloneFrom,
    PROMPT_TEMPLATES: PROMPT_TEMPLATES
  };
  // v7.5: guarded exports — browser keeps window.CustomAgents; node tests
  // can require() this file for the pure merge logic (mergeAgentLists).
  // DOM-dependent members (renderPage, fetchCustomAgents, cloneFrom) are
  // browser-only and are never called in node.
  if (typeof window !== 'undefined') window.CustomAgents = CustomAgentsApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = CustomAgentsApi;
})();
