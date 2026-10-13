'use strict';
/* Symbiote Calling — #37 first-run onboarding tour (v8).
 * Self-initializing on DOMContentLoaded. Index page only (requires #tabs).
 * Injects its own UI; no reliance on other scripts' globals.
 * Runs once per browser (localStorage flag), replayable via the injected
 * "Take the tour" card in Settings and the command palette's "Replay tour". */
(function () {
  var LS_SEEN = 'symbiote-tour-seen-v8';
  var NS = window.__symbioteTour = window.__symbioteTour || {};

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* Step targets are real selectors in index.html:
   * tabs are <button data-view="…">; agent cards are .acard.dir-card inside
   * #agentGrid (rendered async by directory.js). */
  var STEPS = [
    { kicker: 'Welcome', title: 'Meet Symbiote Calling', center: true,
      text: '<strong>101 AI voice agents</strong> you can call from your browser — specialists, a company rep, and agents you build yourself. This 60-second tour shows you around.' },
    { tab: 'agents', sel: '[data-view="agents"]', kicker: '1 · Agents',
      title: 'Your agent directory',
      text: 'Every built-in agent lives here — name, niche, and fictional <strong>+1 (555)</strong> number. Search by name or niche, tap a card for the profile.' },
    { tab: 'customagents', sel: '[data-view="customagents"]', kicker: '2 · Custom agents',
      title: 'Build your own',
      text: 'The guided wizard builds a custom agent from <strong>name → number → role → tone → voice → prompt</strong>. Unlimited agents, saved per key.' },
    { tab: 'dialer', sel: '[data-view="dialer"]', kicker: '3 · Dialer',
      title: 'Dial by number',
      text: 'Know the number? Punch it in — the <strong>smart dialer</strong> suggests matching agents as you type, and Recents redials in one tap.' },
    { tab: 'dashboard', sel: '[data-view="dashboard"]', kicker: '4 · Dashboard',
      title: 'Usage at a glance',
      text: 'Stat cards, your top 5 agents, recent calls — plus v8 <strong>call analytics</strong>, sentiment and lead scoring.' },
    { tab: 'agents', sel: '#agentGrid .acard', waitFor: '#agentGrid .acard', kicker: '5 · Call',
      title: 'Make the call',
      text: 'Tap any card for its profile — <strong>swipe right or use the Call button</strong> to talk. Say <strong>“khuda hafiz”</strong> to hang up hands-free. Go on, try one!' }
  ];

  var els = null, idx = -1, raf = 0, curStep = null;

  function onResize() { if (curStep) track(curStep); }

  function buildDom() {
    if (els) return els;
    window.addEventListener('resize', onResize);
    var catcher = document.createElement('div'); catcher.className = 'tour-catcher';
    var mask = document.createElement('div'); mask.className = 'tour-mask';
    var hole = document.createElement('div'); hole.className = 'tour-hole';
    mask.appendChild(hole);
    var box = document.createElement('div'); box.className = 'tour-box'; box.setAttribute('role', 'dialog');
    box.innerHTML = '<div class="tour-kicker"></div><h3></h3><p></p>' +
      '<div class="tour-nav"><button type="button" class="tour-btn ghost tour-back">Back</button>' +
      '<button type="button" class="tour-btn tour-next">Next</button><div class="tour-dots"></div></div>' +
      '<button type="button" class="tour-skip">Skip tour</button>';
    document.body.appendChild(catcher); document.body.appendChild(mask); document.body.appendChild(box);
    var dots = box.querySelector('.tour-dots');
    STEPS.forEach(function () { dots.appendChild(document.createElement('i')); });
    box.querySelector('.tour-back').addEventListener('click', function () { go(idx - 1); });
    box.querySelector('.tour-next').addEventListener('click', function () { next(); });
    box.querySelector('.tour-skip').addEventListener('click', end);
    els = { catcher: catcher, mask: mask, hole: hole, box: box };
    return els;
  }

  function destroy() {
    if (!els) return;
    [els.catcher, els.mask, els.box].forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    els = null; idx = -1;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    curStep = null;
    window.removeEventListener('resize', onResize);
  }

  function markSeen() { lsSet(LS_SEEN, '1'); }
  function end() { markSeen(); destroy(); }
  function next() { if (idx >= STEPS.length - 1) end(); else go(idx + 1); }

  function switchTab(tab) {
    var btn = document.querySelector('#tabs [data-view="' + tab + '"]');
    if (btn && !btn.classList.contains('active')) btn.click();
  }

  function place(step) {
    var d = buildDom();
    var kick = d.box.querySelector('.tour-kicker'), h = d.box.querySelector('h3'), p = d.box.querySelector('p');
    kick.textContent = step.kicker || '';
    h.textContent = step.title || '';
    p.innerHTML = step.text || '';
    d.box.querySelector('.tour-next').textContent = (idx >= STEPS.length - 1) ? 'Start calling' : 'Next';
    d.box.querySelector('.tour-back').style.visibility = idx === 0 ? 'hidden' : 'visible';
    Array.prototype.forEach.call(d.box.querySelectorAll('.tour-dots i'), function (dot, i) {
      dot.classList.toggle('on', i === idx);
    });
    if (step.center) {
      d.hole.classList.add('welcome');
      d.box.classList.add('center');
      d.box.style.left = ''; d.box.style.top = '';
      return;
    }
    d.hole.classList.remove('welcome');
    d.box.classList.remove('center');
    track(step);
  }

  /* Reposition the spotlight hole + tooltip near the target on every frame
   * while the step is active (cheap; keeps it glued on scroll/resize). */
  function track(step) {
    if (raf) cancelAnimationFrame(raf);
    curStep = step;
    var stepFn = function () {
      if (!els || idx < 0) return;
      var t = step.sel ? document.querySelector(step.sel) : null;
      if (!t) { raf = requestAnimationFrame(stepFn); return; }
      var r = t.getBoundingClientRect();
      var pad = 8;
      var h = els.hole;
      h.style.left = (r.left - pad) + 'px';
      h.style.top = (r.top - pad) + 'px';
      h.style.width = (r.width + pad * 2) + 'px';
      h.style.height = (r.height + pad * 2) + 'px';
      var b = els.box;
      var bw = Math.min(340, window.innerWidth - 48);
      var bx = Math.max(12, Math.min(window.innerWidth - bw - 12, r.left + r.width / 2 - bw / 2));
      var below = r.bottom + pad + 16 + 190;
      var by = (below < window.innerHeight) ? (r.bottom + pad + 16) : Math.max(12, r.top - pad - 16 - 210);
      b.style.width = bw + 'px';
      b.style.left = bx + 'px';
      b.style.top = by + 'px';
      raf = requestAnimationFrame(stepFn);
    };
    stepFn();
  }

  function go(i) {
    var step = STEPS[i];
    if (!step) { end(); return; }
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    curStep = null;
    idx = i;
    if (step.tab) switchTab(step.tab);
    /* Cards render async — wait for the target before placing. */
    var tries = 0;
    var wait = function () {
      var ok = !step.waitFor || document.querySelector(step.waitFor);
      if (ok || tries++ > 40) place(step);
      else setTimeout(wait, 150);
    };
    setTimeout(wait, step.tab ? 200 : 0);
  }

  function start(force) {
    if (!document.getElementById('tabs')) return; /* index page only */
    if (!force && lsGet(LS_SEEN)) return;
    /* Never start over the key gate — wait until the user unlocks the app. */
    var tries = 0;
    var waitGate = function () {
      if (!document.body.classList.contains('kg-gated') || tries++ > 120) { destroy(); go(0); }
      else setTimeout(waitGate, 500);
    };
    waitGate();
  }

  /* "Replay tour" injection — a card at the end of the Settings view. */
  function injectReplayButton() {
    if (!document.getElementById('tabs')) return;
    if (document.getElementById('tourReplayBtn')) return;
    var settings = document.getElementById('view-settings');
    if (!settings) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="tour-replay"><div class="t"><b>Guided tour</b>' +
      '<span>Replay the 60-second first-run tour.</span></div>' +
      '<button class="btn ghost" id="tourReplayBtn" type="button">Replay tour</button></div>';
    settings.appendChild(card);
    card.querySelector('#tourReplayBtn').addEventListener('click', function () { start(true); });
  }

  NS.start = start;
  NS.replay = function () { start(true); };

  ready(function () {
    injectReplayButton();
    start(false);
  });
})();
