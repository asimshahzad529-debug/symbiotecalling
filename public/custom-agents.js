'use strict';
/**
 * public/custom-agents.js — v7 custom agent builder UI (WS2), v8 wizard (W1).
 *
 * window.CustomAgents.renderPage(container) — full page: list + wizard builder.
 * API via window.KeyGate.apiFetch when present (key-gating workstream),
 * else plain fetch. No API key ever goes into URLs.
 *
 * v8.0.0: the "Clone a built-in agent…" dropdown is GONE from this page
 * (F1) — built-in cloning still works through directory.js's Clone button,
 * which calls window.CustomAgents.cloneFrom(agent); the pre-filled draft
 * stashed by cloneFrom() now opens the step wizard (F2) seeded with it.
 *
 * v7.5: no avatar upload — every custom agent uses the default phone-caller
 * avatar. No avatar upload is reintroduced here.
 *
 * Exposed for other v7 modules (directory/dialer/history/stats merge):
 *   window.CustomAgents.mergeAgentLists(builtinList, customList)
 *   window.CustomAgents.fetchCustomAgents() -> Promise<[publicCustomAgent]>
 *   window.CustomAgents.avatarUrlFor(agent)   // v7.5: always null — default avatar only
 *   window.CustomAgents.PROMPT_TEMPLATES
 */

(function () {
  var API = '/api/v7/custom-agents';
  var TONES = [
    { value: 'professional', title: 'Professional', desc: 'Polite, businesslike and to the point.' },
    { value: 'friendly',     title: 'Friendly',     desc: 'Warm, upbeat and welcoming.' },
    { value: 'confident',    title: 'Confident',    desc: 'Bold, persuasive and assured.' },
    { value: 'casual',       title: 'Casual',       desc: 'Relaxed, natural and conversational.' }
  ];

  // v7 WS7 adapter: directory.js profileSheet calls
  // window.CustomAgents.cloneFrom(agent) with a built-in agent object.
  // Custom agents are never cloneable — this is rejected here, at the
  // button level, and server-side. We fetch a pre-filled draft from the
  // clone API, stash it, and ask app.js (via event) to open the Custom
  // Agents page — renderPage() picks the draft up and opens the wizard
  // seeded with it.
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

  // ---------------- v8 builder wizard ----------------
  // UNVERIFIED-LIVE: this wizard's step navigation, tone-card selection and
  // create flow need a real browser to confirm (no live browser available to
  // the worker). Verified so far: node --check syntax, merge/avatar stubs,
  // and API/payload parity with the v7.5 form.
  var WIZ_STEPS = [
    { id: 'name',   title: 'Name',    sub: 'What should callers hear?' },
    { id: 'number', title: 'Number',  sub: 'Your agent\u2019s phone number' },
    { id: 'role',   title: 'Role',    sub: 'What does this agent do?' },
    { id: 'tone',   title: 'Tone',    sub: 'How should it sound?' },
    { id: 'voice',  title: 'Voice',   sub: 'Pick a voice' },
    { id: 'prompt', title: 'Prompt',  sub: 'Extra instructions (optional)' },
    { id: 'review', title: 'Review',  sub: 'Check everything before creating' }
  ];

  function buildWizard(container, existing, voices, onSaved, onCancel) {
    var editing = !!existing;
    var data = {
      name:   existing ? String(existing.name || '') : '',
      number: existing ? String(existing.number || '') : '',
      role:   existing ? String(existing.role || '') : '',
      tone:   (existing && existing.tone) || 'professional',
      voice:  (existing && existing.voice) || null,
      prompt: existing ? String(existing.prompt || '') : ''
    };
    var voiceOpts = voices && voices.length ? voices.slice() : ['Charon'];
    if (data.voice && voiceOpts.indexOf(data.voice) === -1) voiceOpts.unshift(data.voice);
    if (!data.voice) data.voice = voiceOpts[0];
    var step = 0;

    var wiz = el('div', 'ca-wiz');
    var head = el('div', 'ca-wiz-head');
    head.appendChild(el('h3', 'ca-wiz-title', editing ? 'Edit agent' : 'New custom agent'));
    var stepLabel = el('div', 'ca-wiz-label');
    head.appendChild(stepLabel);
    var bar = el('div', 'ca-wiz-progress');
    var barFill = el('div', 'ca-wiz-progress-fill');
    bar.appendChild(barFill);
    head.appendChild(bar);
    var dots = el('div', 'ca-wiz-steps');
    WIZ_STEPS.forEach(function (s, i) {
      var d = el('span', 'ca-wiz-dot', String(i + 1));
      d.title = (i + 1) + '. ' + s.title;
      dots.appendChild(d);
    });
    head.appendChild(dots);
    wiz.appendChild(head);

    var body = el('div', 'ca-wiz-body');
    wiz.appendChild(body);
    var err = el('div', 'ca-error');
    err.style.display = 'none';
    wiz.appendChild(err);

    var nav = el('div', 'ca-wiz-btns');
    var left = el('div', 'ca-wiz-nav-left');
    var right = el('div', 'ca-wiz-nav-right');
    var backBtn = el('button', 'ca-btn', '\u2190 Back');
    var cancelBtn = el('button', 'ca-btn ca-btn-ghost', 'Cancel');
    var nextBtn = el('button', 'ca-btn ca-btn-primary', 'Continue \u2192');
    var createBtn = el('button', 'ca-btn ca-btn-primary', editing ? 'Save changes' : 'Create agent');
    backBtn.type = 'button'; cancelBtn.type = 'button';
    nextBtn.type = 'button'; createBtn.type = 'button';
    left.appendChild(backBtn);
    right.appendChild(cancelBtn); right.appendChild(nextBtn); right.appendChild(createBtn);
    nav.appendChild(left); nav.appendChild(right);
    wiz.appendChild(nav);
    container.appendChild(wiz);

    function showError(m) { err.textContent = m; err.style.display = m ? '' : 'none'; }

    function field(labelText, inputEl, hint) {
      var w = el('div', 'ca-field');
      var lab = el('label', '', labelText);
      w.appendChild(lab); w.appendChild(inputEl);
      if (hint) w.appendChild(el('div', 'ca-hint', hint));
      return w;
    }

    function textInput(value, placeholder, maxLen) {
      var i = document.createElement('input');
      i.type = 'text'; i.maxLength = maxLen; i.placeholder = placeholder;
      i.value = value;
      return i;
    }

    var inputs = {}; // step id -> live input element

    function renderStep() {
      showError('');
      body.innerHTML = '';
      var id = WIZ_STEPS[step].id;
      stepLabel.textContent = 'Step ' + (step + 1) + ' of ' + WIZ_STEPS.length +
        ' — ' + WIZ_STEPS[step].title;
      barFill.style.width = ((step + 1) / WIZ_STEPS.length * 100) + '%';
      var dotEls = dots.querySelectorAll('.ca-wiz-dot');
      for (var k = 0; k < dotEls.length; k++) {
        dotEls[k].className = 'ca-wiz-dot' +
          (k === step ? ' active' : k < step ? ' done' : '');
      }

      if (id === 'name') {
        var nI = textInput(data.name, 'e.g. Zara Khan', 60);
        nI.addEventListener('input', function () { data.name = nI.value; });
        inputs.name = nI;
        body.appendChild(field('Agent name *', nI, 'The name callers will hear and see.'));
        nI.focus();
      } else if (id === 'number') {
        var pI = textInput(data.number, 'any number, kept as typed', 24);
        pI.addEventListener('input', function () { data.number = pI.value; });
        inputs.number = pI;
        body.appendChild(field('Phone number *', pI, 'Any number — kept exactly as you type it.'));
        pI.focus();
      } else if (id === 'role') {
        var rI = textInput(data.role, 'e.g. Real estate advisor', 120);
        rI.addEventListener('input', function () { data.role = rI.value; });
        inputs.role = rI;
        body.appendChild(field('Role *', rI, 'What this agent does — shown as its specialty.'));
        rI.focus();
      } else if (id === 'tone') {
        var grid = el('div', 'ca-tone-grid');
        TONES.forEach(function (t) {
          var card = document.createElement('button');
          card.type = 'button';
          card.className = 'ca-tone-card' + (data.tone === t.value ? ' sel' : '');
          var ttl = el('div', 'ca-tone-title', t.title);
          var dsc = el('div', 'ca-tone-desc', t.desc);
          card.appendChild(ttl); card.appendChild(dsc);
          card.addEventListener('click', function () {
            data.tone = t.value;
            var cards = grid.querySelectorAll('.ca-tone-card');
            for (var i = 0; i < cards.length; i++) cards[i].classList.remove('sel');
            card.classList.add('sel');
          });
          grid.appendChild(card);
        });
        body.appendChild(el('div', 'ca-field'));
        body.firstChild.appendChild(el('label', '', 'Tone *'));
        body.firstChild.appendChild(grid);
      } else if (id === 'voice') {
        var vS = document.createElement('select');
        voiceOpts.forEach(function (v) {
          var o = document.createElement('option');
          o.value = v; o.textContent = v;
          if (data.voice === v) o.selected = true;
          vS.appendChild(o);
        });
        vS.addEventListener('change', function () { data.voice = vS.value; });
        inputs.voice = vS;
        body.appendChild(field('Voice', vS, 'The voice callers will hear on this agent.'));
        vS.focus();
      } else if (id === 'prompt') {
        var tA = document.createElement('textarea');
        tA.rows = 6; tA.maxLength = 4000;
        tA.placeholder = 'Optional: extra instructions for this agent…';
        tA.value = data.prompt;
        tA.addEventListener('input', function () { data.prompt = tA.value; });
        inputs.prompt = tA;
        body.appendChild(field('Prompt (optional)', tA, 'Extra behavior instructions, up to 4000 characters.'));
        var tplRow = el('div', 'ca-templates');
        Object.keys(PROMPT_TEMPLATES).forEach(function (name) {
          var b = el('button', 'ca-chip', name);
          b.type = 'button';
          b.addEventListener('click', function () {
            data.prompt = PROMPT_TEMPLATES[name];
            tA.value = data.prompt;
            tA.focus();
          });
          tplRow.appendChild(b);
        });
        body.appendChild(tplRow);
        tA.focus();
      } else if (id === 'review') {
        var rev = el('div', 'ca-wiz-review');
        var toneTitle = data.tone.charAt(0).toUpperCase() + data.tone.slice(1);
        var rows = [
          ['Name', data.name], ['Number', data.number], ['Role', data.role],
          ['Tone', toneTitle], ['Voice', data.voice],
          ['Prompt', data.prompt.trim() ? data.prompt.trim() : '— (none)']
        ];
        rows.forEach(function (r) {
          var row = el('div', 'ca-wiz-review-row');
          row.appendChild(el('div', 'ca-wiz-review-label', r[0]));
          row.appendChild(el('div', 'ca-wiz-review-value', r[1]));
          rev.appendChild(row);
        });
        rev.appendChild(el('div', 'ca-hint', 'Default phone-caller avatar · works like a built-in agent'));
        body.appendChild(rev);
      }

      backBtn.style.visibility = step === 0 ? 'hidden' : '';
      nextBtn.style.display = step === WIZ_STEPS.length - 1 ? 'none' : '';
      createBtn.style.display = step === WIZ_STEPS.length - 1 ? '' : 'none';
    }

    function validateStep() {
      var id = WIZ_STEPS[step].id;
      if (id === 'name') {
        if (!data.name.trim()) return 'Please enter a name for this agent.';
      } else if (id === 'number') {
        if (!data.number.trim()) return 'Please enter a phone number.';
      } else if (id === 'role') {
        if (!data.role.trim()) return 'Please describe this agent\u2019s role.';
      }
      return null;
    }

    nextBtn.addEventListener('click', function () {
      var bad = validateStep();
      if (bad) { showError(bad); return; }
      if (step < WIZ_STEPS.length - 1) { step++; renderStep(); }
    });
    backBtn.addEventListener('click', function () {
      if (step > 0) { step--; renderStep(); }
    });
    cancelBtn.addEventListener('click', onCancel);

    createBtn.addEventListener('click', function () {
      var payload = {
        name: data.name.trim(),
        number: data.number.trim(),
        role: data.role.trim(),
        tone: data.tone,
        voice: data.voice,
        prompt: data.prompt
      };
      if (!payload.name) { showError('Please enter a name for this agent.'); return; }
      if (!payload.number) { showError('Please enter a phone number.'); return; }
      if (!payload.role) { showError('Please describe this agent\u2019s role.'); return; }
      createBtn.disabled = true;
      var p = editing
        ? api(API + '/' + encodeURIComponent(existing.id), 'PUT', payload)
        : api(API, 'POST', payload);
      p.then(function (j) {
        notifyChanged(editing ? 'updated' : 'created', j.agent && j.agent.id);
        onSaved(j.agent);
      }).catch(function (e) { showError(e.message); createBtn.disabled = false; });
    });

    renderStep();
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
    // F1: the "Clone a built-in agent…" dropdown is removed entirely —
    // cloning is handled by directory.js's Clone button via cloneFrom().
    root.appendChild(head);
    var listEl = el('div', 'ca-list');
    root.appendChild(listEl);
    var formHost = el('div', 'ca-form-host');
    root.appendChild(formHost);
    container.appendChild(root);

    var voices = [];
    var agents = [];

    // Voices only — the clone dropdown population that used to live here is gone.
    function loadVoices() {
      return apiFetch('/api/agents', { method: 'GET' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          var seen = {};
          (j.agents || []).forEach(function (a) { if (a.voice) seen[a.voice] = 1; });
          return Object.keys(seen).sort();
        })
        .catch(function () { return []; });
    }

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
        bEdit.addEventListener('click', function () { openWizard(a); });
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

    function openWizard(existing, draft) {
      formHost.innerHTML = '';
      var seed = existing || (draft ? {
        name: draft.name, number: draft.number, role: draft.role,
        tone: draft.tone, voice: draft.voice, prompt: draft.prompt
      } : null);
      buildWizard(formHost, seed, voices, function () {
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

    newBtn.addEventListener('click', function () { openWizard(null, null); });
    loadVoices().then(function (v) { voices = v; });
    refresh();
    // WS7 adapter: a clone draft stashed by cloneFrom() opens the builder
    // wizard as soon as the page renders.
    if (pendingDraft) {
      var draft = pendingDraft;
      pendingDraft = null;
      openWizard(null, draft);
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
