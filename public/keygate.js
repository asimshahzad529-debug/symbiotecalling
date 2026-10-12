'use strict';
/* public/keygate.js — v7 key gating for Symbiote Calling.
 *
 * window.KeyGate:
 *   init()        -> Promise; shows a premium login overlay when no API key
 *                    is stored, and hides the main UI until login. Resolves
 *                    once a key is active. MUST be awaited before any
 *                    rendering or API calls (see contract in src/apiv7_keygate.js).
 *   getKey()      -> the raw API key (for the /live WebSocket setup message ONLY)
 *   getKeyHash()  -> Promise<sha256 hex> of the key (crypto.subtle)
 *   apiFetch(path, opts) -> fetch() with the `x-key-hash` header attached.
 *                    Use for every /api/* call. The raw key never goes in a URL.
 *   login(key, label) / logout() / switchProfile(label) / deleteProfile(label)
 *   openSwitcher(mountEl) -> profile modal: list labels, switch, delete, log out.
 *
 * Keys live in localStorage only — never in URLs, never in page state.
 * Only the key's SHA-256 hash ever leaves the device (as a header).
 */
(function () {
  var LS_KEYS = 'symbiote-keys-v1';       // [{ label, key, keyHash }]
  var LS_ACTIVE = 'symbiote-active-key-v1'; // label of the active profile

  function sha256hex(str) {
    if (!window.crypto || !window.crypto.subtle || !window.crypto.subtle.digest) {
      return Promise.reject(new Error('WebCrypto unavailable — use a secure context (https or localhost)'));
    }
    var data = (typeof TextEncoder !== 'undefined')
      ? new TextEncoder().encode(String(str))
      : null;
    if (!data) return Promise.reject(new Error('TextEncoder unavailable'));
    return window.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      var bytes = new Uint8Array(buf), out = '';
      for (var i = 0; i < bytes.length; i++) {
        var h = bytes[i].toString(16);
        out += (h.length === 1 ? '0' + h : h);
      }
      return out;
    });
  }

  function loadStored() {
    try {
      var arr = JSON.parse(window.localStorage.getItem(LS_KEYS) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveStored(arr) {
    try { window.localStorage.setItem(LS_KEYS, JSON.stringify(arr)); } catch (e) {}
  }
  function activeLabel() {
    try { return window.localStorage.getItem(LS_ACTIVE); } catch (e) { return null; }
  }
  function setActiveLabel(l) {
    try {
      if (l == null) window.localStorage.removeItem(LS_ACTIVE);
      else window.localStorage.setItem(LS_ACTIVE, l);
    } catch (e) {}
  }
  function findByLabel(stored, label) {
    for (var i = 0; i < stored.length; i++) if (stored[i] && stored[i].label === label) return stored[i];
    return null;
  }
  function maskedHash(kh) { return kh ? kh.slice(0, 8) + '…' + kh.slice(-4) : ''; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function on(node, type, fn) {
    if (node.addEventListener) node.addEventListener(type, fn);
    else node['on' + type] = fn;
  }

  var KeyGate = {
    _key: null,
    _keyHash: null,
    _ready: null,
    _readyResolve: null,

    /* ---------- boot ---------- */

    init: function () {
      var self = this;
      if (this._ready) return this._ready;
      this._ready = new Promise(function (resolve) { self._readyResolve = resolve; });
      var stored = loadStored();
      var rec = findByLabel(stored, activeLabel());
      if (!rec && stored.length === 1) rec = stored[0]; // single profile: just log in
      if (rec && rec.key) {
        this._key = rec.key;
        this._keyHash = rec.keyHash || null;
        this._hideOverlay();
        this._resolveReady(false);
      } else {
        this._showOverlay();
      }
      return this._ready;
    },

    _resolveReady: function (fresh) {
      if (this._readyResolve) {
        var r = this._readyResolve;
        this._readyResolve = null;
        r({ key: this._key, fresh: !!fresh });
      }
    },

    /* ---------- key access ---------- */

    getKey: function () { return this._key; },

    getKeyHash: function () {
      var self = this;
      if (this._keyHash) return Promise.resolve(this._keyHash);
      if (!this._key) return Promise.reject(new Error('no key: login required'));
      return sha256hex(this._key).then(function (kh) { self._keyHash = kh; return kh; });
    },

    /** fetch() wrapper that attaches the x-key-hash header. Raw key never in URL. */
    apiFetch: function (path, opts) {
      return this.getKeyHash().then(function (kh) {
        opts = opts || {};
        var headers = {};
        if (opts.headers) {
          for (var k in opts.headers) headers[k] = opts.headers[k];
        }
        headers['x-key-hash'] = kh || '';
        var merged = {};
        for (var k2 in opts) merged[k2] = opts[k2];
        merged.headers = headers;
        return window.fetch(path, merged);
      });
    },

    /* ---------- login / profiles ---------- */

    login: function (key, label) {
      var self = this;
      key = String(key == null ? '' : key).trim();
      if (!key) return Promise.reject(new Error('API key required'));
      return sha256hex(key).then(function (kh) {
        var stored = loadStored();
        var name = String(label == null ? '' : label).trim().slice(0, 80) || ('Key ' + (stored.length + 1));
        var found = false;
        stored = stored.map(function (p) {
          if (p && p.keyHash === kh) { found = true; return { label: name, key: key, keyHash: kh }; }
          return p;
        });
        if (!found) stored.push({ label: name, key: key, keyHash: kh });
        saveStored(stored);
        setActiveLabel(name);
        self._key = key;
        self._keyHash = kh;
        // Register the profile server-side (best effort — never blocks login).
        self.apiFetch('/api/v7/key/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyHash: kh, label: name })
        }).catch(function () {});
        self._hideOverlay();
        self._resolveReady(true);
        return { keyHash: kh, label: name };
      });
    },

    logout: function () {
      var self = this;
      this._key = null;
      this._keyHash = null;
      setActiveLabel(null);
      this._ready = new Promise(function (resolve) { self._readyResolve = resolve; });
      this._showOverlay();
      return this._ready;
    },

    listLocalProfiles: function () { return loadStored(); },

    switchProfile: function (label) {
      var rec = findByLabel(loadStored(), label);
      if (!rec || !rec.key) return false;
      setActiveLabel(rec.label);
      this._key = rec.key;
      this._keyHash = rec.keyHash || null;
      this._hideOverlay();
      this._resolveReady(false);
      return true;
    },

    deleteProfile: function (label) {
      var self = this;
      var stored = loadStored();
      var rec = findByLabel(stored, label);
      if (!rec) return Promise.resolve(false);
      stored = stored.filter(function (p) { return !p || p.label !== label; });
      saveStored(stored);
      var wasActive = this._key && rec.key === this._key;
      // Remove server-side too (best effort).
      var done = rec.keyHash
        ? this.apiFetch('/api/v7/key/profiles/' + encodeURIComponent(rec.keyHash), { method: 'DELETE' }).catch(function () {})
        : Promise.resolve();
      return done.then(function () {
        if (wasActive) self.logout();
        return true;
      });
    },

    /* ---------- login overlay ---------- */

    _overlay: null,

    _showOverlay: function () {
      if (this._overlay) return;
      document.body.classList.add('kg-gated');
      var self = this;
      var overlay = el('div', 'kg-overlay');
      var card = el('div', 'kg-card');
      var brand = el('div', 'kg-brand');
      brand.innerHTML = '<span class="kg-sigil">\u25C8</span> Symbiote <em>Calling</em>';
      card.appendChild(brand);
      card.appendChild(el('h2', 'kg-title', 'Unlock Symbiote Calling'));
      card.appendChild(el('p', 'kg-sub', 'Sign in with your Gemini API key. The key stays on this device \u2014 only its hash ever leaves it.'));

      var profWrap = el('div', 'kg-profiles');
      this._renderOverlayProfiles(profWrap);
      card.appendChild(profWrap);

      card.appendChild(el('label', 'kg-label', 'API key'));
      var keyInput = el('input', 'kg-input kg-key-input');
      keyInput.type = 'password';
      keyInput.placeholder = 'AIza\u2026';
      keyInput.setAttribute('autocomplete', 'off');
      keyInput.setAttribute('spellcheck', 'false');
      card.appendChild(keyInput);

      card.appendChild(el('label', 'kg-label', 'Label (optional)'));
      var labelInput = el('input', 'kg-input kg-label-input');
      labelInput.type = 'text';
      labelInput.placeholder = 'e.g. Work key';
      labelInput.setAttribute('maxlength', '80');
      labelInput.setAttribute('autocomplete', 'off');
      card.appendChild(labelInput);

      var err = el('div', 'kg-error');
      err.hidden = true;
      card.appendChild(err);

      var btn = el('button', 'kg-unlock', 'Unlock');
      btn.type = 'button';
      function doUnlock() {
        err.hidden = true;
        btn.disabled = true;
        btn.textContent = 'Unlocking\u2026';
        self.login(keyInput.value, labelInput.value).then(function () {
          btn.disabled = false;
          btn.textContent = 'Unlock';
          keyInput.value = '';
        }).catch(function (e) {
          btn.disabled = false;
          btn.textContent = 'Unlock';
          err.textContent = (e && e.message) || 'Login failed';
          err.hidden = false;
        });
      }
      on(btn, 'click', doUnlock);
      on(keyInput, 'keydown', function (e) { if (e.key === 'Enter') doUnlock(); });
      on(labelInput, 'keydown', function (e) { if (e.key === 'Enter') doUnlock(); });
      card.appendChild(btn);

      var getKey = el('a', 'kg-getkey', 'Get a free API key \u2192');
      getKey.href = 'https://aistudio.google.com/apikey';
      getKey.target = '_blank';
      getKey.rel = 'noopener';
      card.appendChild(getKey);

      overlay.appendChild(card);
      document.body.appendChild(overlay);
      this._overlay = overlay;
      try { keyInput.focus(); } catch (e) {}
    },

    _renderOverlayProfiles: function (wrap) {
      var self = this;
      wrap.innerHTML = '';
      var stored = loadStored();
      if (!stored.length) return;
      wrap.appendChild(el('div', 'kg-profiles-title', 'Saved keys'));
      stored.forEach(function (p) {
        var row = el('div', 'kg-profile-row');
        var meta = el('div', 'kg-profile-meta');
        meta.appendChild(el('div', 'kg-profile-label', p.label));
        meta.appendChild(el('div', 'kg-profile-hash mono', maskedHash(p.keyHash)));
        row.appendChild(meta);
        var use = el('button', 'kg-btn', 'Use');
        use.type = 'button';
        on(use, 'click', function () { self.switchProfile(p.label); });
        row.appendChild(use);
        wrap.appendChild(row);
      });
    },

    _hideOverlay: function () {
      document.body.classList.remove('kg-gated');
      if (this._overlay && this._overlay.parentNode) {
        this._overlay.parentNode.removeChild(this._overlay);
      }
      this._overlay = null;
    },

    /* ---------- profile switcher modal (for the Settings view) ---------- */

    openSwitcher: function (mountEl) {
      var self = this;
      this.closeSwitcher();
      var host = mountEl || document.body;
      var modal = el('div', 'kg-modal');
      var card = el('div', 'kg-card kg-switcher');

      var head = el('div', 'kg-switcher-head');
      head.appendChild(el('h3', null, 'API keys'));
      var close = el('button', 'kg-x', '\u00D7');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close');
      on(close, 'click', function () { self.closeSwitcher(); });
      head.appendChild(close);
      card.appendChild(head);
      card.appendChild(el('p', 'kg-sub', 'Each key keeps its own agents, history and memories.'));

      var list = el('div', 'kg-switcher-list');
      function render() {
        list.innerHTML = '';
        var stored = loadStored();
        if (!stored.length) list.appendChild(el('p', 'dim', 'No saved keys yet.'));
        stored.forEach(function (p) {
          var row = el('div', 'kg-profile-row');
          var meta = el('div', 'kg-profile-meta');
          meta.appendChild(el('div', 'kg-profile-label', p.label));
          meta.appendChild(el('div', 'kg-profile-hash mono', maskedHash(p.keyHash)));
          row.appendChild(meta);
          var isActive = self._key && p.key === self._key;
          if (!isActive) {
            var use = el('button', 'kg-btn', 'Switch');
            use.type = 'button';
            on(use, 'click', function () { self.switchProfile(p.label); self.closeSwitcher(); });
            row.appendChild(use);
          } else {
            row.appendChild(el('span', 'kg-active-tag', 'active'));
          }
          var del = el('button', 'kg-btn danger', 'Delete');
          del.type = 'button';
          on(del, 'click', function () {
            if (del.getAttribute('data-arm') === '1') {
              self.deleteProfile(p.label).then(function () { render(); });
            } else {
              del.setAttribute('data-arm', '1');
              del.textContent = 'Sure?';
            }
          });
          row.appendChild(del);
          list.appendChild(row);
        });
      }
      render();
      card.appendChild(list);

      var foot = el('div', 'kg-switcher-foot');
      var addBtn = el('button', 'kg-btn', '+ Add key');
      addBtn.type = 'button';
      on(addBtn, 'click', function () { self.closeSwitcher(); self.logout(); });
      foot.appendChild(addBtn);
      var outBtn = el('button', 'kg-btn danger', 'Log out');
      outBtn.type = 'button';
      on(outBtn, 'click', function () { self.closeSwitcher(); self.logout(); });
      foot.appendChild(outBtn);
      card.appendChild(foot);

      modal.appendChild(card);
      on(modal, 'click', function (e) { if (e.target === modal) self.closeSwitcher(); });
      host.appendChild(modal);
      this._switcher = modal;
      return modal;
    },

    _switcher: null,
    closeSwitcher: function () {
      if (this._switcher && this._switcher.parentNode) {
        this._switcher.parentNode.removeChild(this._switcher);
      }
      this._switcher = null;
    },

    /* test hook: pure helpers without DOM */
    _sha256hex: sha256hex
  };

  window.KeyGate = KeyGate;
})();
