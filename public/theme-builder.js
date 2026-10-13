/* Symbiote Calling — v8 theme builder (#59).
 *
 * Lets the user build a custom color theme from a few brand colors and
 * preview it live. Implementation sets the app's existing CSS variables on
 * document.documentElement via style.setProperty — it only overrides
 * variables, so it composes with the Light / Dark / System mode switcher.
 * The custom theme is persisted per API key in localStorage (keyed under the
 * active keyHash read from keygate's storage records, read-only); with no
 * key on file it falls back to a global key.
 *
 * Pure core (color utils + derive()) is node-testable; the DOM boot is
 * guarded so requiring this file in node never touches the DOM.
 */
(function (global) {
  'use strict';

  /* ---------- variable contract (existing names only) ---------- */
  var VARS = [
    '--acc', '--acc-soft', '--acc2',
    '--bg', '--bg2', '--panel', '--panel2',
    '--ink', '--ink2', '--dim', '--muted',
    '--line', '--line2',
    '--ok', '--err', '--ring', '--shadow'
  ];

  var LS_PREFIX = 'symbiote-theme-v1:'; // + keyHash, or 'global'
  var KG_KEYS = 'symbiote-keys-v1';       // keygate storage (read-only)
  var KG_ACTIVE = 'symbiote-active-key-v1';

  /* ---------- color utils ---------- */
  function clamp255(n) { n = Math.round(n); return n < 0 ? 0 : (n > 255 ? 255 : n); }

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    var h = hex.replace(/^#/, '').trim();
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  }

  function rgbToHex(r, g, b) {
    function p(n) { var s = clamp255(n).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + p(r) + p(g) + p(b);
  }

  /* mix a toward b by t (0..1) */
  function mix(a, b, t) {
    var ra = hexToRgb(a), rb = hexToRgb(b);
    if (!ra || !rb) return a;
    t = Math.max(0, Math.min(1, t));
    return rgbToHex(
      ra[0] + (rb[0] - ra[0]) * t,
      ra[1] + (rb[1] - ra[1]) * t,
      ra[2] + (rb[2] - ra[2]) * t
    );
  }

  function withAlpha(hex, a) {
    var r = hexToRgb(hex);
    if (!r) return hex;
    return 'rgba(' + r[0] + ',' + r[1] + ',' + r[2] + ',' + a + ')';
  }

  /* relative luminance 0..1 */
  function lum(hex) {
    var r = hexToRgb(hex);
    if (!r) return 0;
    function lin(c) {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(r[0]) + 0.7152 * lin(r[1]) + 0.0722 * lin(r[2]);
  }

  /* amt > 0 lightens, < 0 darkens (fraction of full range) */
  function shade(hex, amt) {
    var r = hexToRgb(hex);
    if (!r) return hex;
    var t = amt > 0 ? [255, 255, 255] : [0, 0, 0];
    var f = Math.abs(amt);
    return rgbToHex(
      r[0] + (t[0] - r[0]) * f,
      r[1] + (t[1] - r[1]) * f,
      r[2] + (t[2] - r[2]) * f
    );
  }

  /* ---------- palette -> full variable map ---------- */
  function derive(p) {
    var accent = p.accent, accent2 = p.accent2, bg = p.bg, surface = p.surface, ink = p.ink;
    var bgIsLight = lum(bg) >= 0.5;
    var surfIsLight = lum(surface) >= 0.5;
    return {
      '--acc': accent,
      '--acc-soft': withAlpha(accent, 0.12),
      '--acc2': accent2,
      '--bg': bg,
      '--bg2': shade(bg, -0.05),
      '--panel': surface,
      '--panel2': shade(surface, surfIsLight ? -0.05 : 0.06),
      '--ink': ink,
      '--ink2': mix(ink, bg, 0.30),
      '--dim': mix(ink, bg, 0.55),
      '--muted': mix(ink, bg, 0.46),
      '--line': withAlpha(ink, 0.13),
      '--line2': withAlpha(ink, 0.24),
      '--ok': bgIsLight ? '#15803d' : '#34d399',
      '--err': bgIsLight ? '#b91c1c' : '#f87171',
      '--ring': withAlpha(accent, 0.38),
      '--shadow': bgIsLight
        ? '0 10px 28px -18px ' + withAlpha(ink, 0.35)
        : '0 18px 44px -22px rgba(0,0,0,0.7)'
    };
  }

  /* ---------- presets ---------- */
  var PRESETS = [
    { name: 'Ocean', desc: 'Deep-sea blues',
      palette: { accent: '#38bdf8', accent2: '#818cf8', bg: '#0a1420', surface: '#101e2c', ink: '#eaf3fa' } },
    { name: 'Sunset', desc: 'Warm ember',
      palette: { accent: '#fb923c', accent2: '#f472b6', bg: '#1a0f0d', surface: '#251512', ink: '#fbeee6' } },
    { name: 'Forest', desc: 'Moss & pine',
      palette: { accent: '#34d399', accent2: '#a3e635', bg: '#0c1410', surface: '#122019', ink: '#eaf5ee' } },
    { name: 'Mono', desc: 'Clean grayscale',
      palette: { accent: '#52525b', accent2: '#a1a1aa', bg: '#fafafa', surface: '#ffffff', ink: '#18181b' } }
  ];

  var FIELDS = [
    { key: 'accent', label: 'Primary accent', desc: 'Buttons, highlights, active states' },
    { key: 'accent2', label: 'Secondary accent', desc: 'Badges, gradients, secondary highlights' },
    { key: 'bg', label: 'Background', desc: 'App backdrop' },
    { key: 'surface', label: 'Surface', desc: 'Cards, panels, inputs' },
    { key: 'ink', label: 'Text', desc: 'Primary text color' }
  ];

  /* ---------- persistence (per API key; keygate records read-only) ---------- */
  function activeKeyHashSync() {
    try {
      var ls = global.localStorage;
      if (!ls) return null;
      var stored = JSON.parse(ls.getItem(KG_KEYS) || '[]');
      var label = ls.getItem(KG_ACTIVE);
      if (Array.isArray(stored)) {
        for (var i = 0; i < stored.length; i++) {
          var p = stored[i];
          if (p && p.keyHash && (label ? p.label === label : true)) return p.keyHash;
        }
        if (stored.length === 1 && stored[0] && stored[0].keyHash) return stored[0].keyHash;
      }
    } catch (e) { /* private mode etc. */ }
    return null;
  }

  function storageKey() {
    var kh = activeKeyHashSync();
    return LS_PREFIX + (kh || 'global');
  }

  function loadSaved() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(storageKey());
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && o.palette && hexToRgb(o.palette.accent)) ? o : null;
    } catch (e) { return null; }
  }

  function saveCurrent(palette) {
    try {
      global.localStorage.setItem(storageKey(), JSON.stringify({
        v: 1, palette: palette, savedAt: Date.now()
      }));
      return true;
    } catch (e) { return false; }
  }

  function clearSaved() {
    try { global.localStorage.removeItem(storageKey()); } catch (e) {}
  }

  /* ---------- apply / clear (documentElement only) ---------- */
  function applyVars(vars, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.documentElement) return 0;
    var st = doc.documentElement.style, n = 0;
    for (var i = 0; i < VARS.length; i++) {
      var k = VARS[i];
      if (vars[k] != null) { st.setProperty(k, vars[k]); n++; }
    }
    return n;
  }

  function clearVars(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.documentElement) return 0;
    var st = doc.documentElement.style, n = 0;
    for (var i = 0; i < VARS.length; i++) { st.removeProperty(VARS[i]); n++; }
    return n;
  }

  function applyPalette(palette) { return applyVars(derive(palette)); }

  /* node export for tests — assign onto the existing exports object (not
     replace) so the IIFE's captured scope object and require() stay the same */
  var api = {
    VARS: VARS, PRESETS: PRESETS, FIELDS: FIELDS,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex, mix: mix,
    withAlpha: withAlpha, lum: lum, shade: shade,
    derive: derive, applyVars: applyVars, clearVars: clearVars,
    applyPalette: applyPalette, loadSaved: loadSaved,
    saveCurrent: saveCurrent, clearSaved: clearSaved,
    storageKey: storageKey, activeKeyHashSync: activeKeyHashSync
  };
  if (typeof module !== 'undefined' && module.exports) {
    for (var _k in api) module.exports[_k] = api[_k];
  }

  /* ================= browser UI ================= */
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  var state = {
    palette: null,   // current draft palette
    saved: false,    // draft matches persisted theme
    inputs: {}       // field key -> { color, hex }
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function normHex(v) {
    var h = String(v || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return /^[0-9a-fA-F]{6}$/.test(h) ? '#' + h.toLowerCase() : null;
  }

  function currentPalette() { return state.palette; }

  function renderPalette(p) {
    state.palette = {
      accent: normHex(p.accent) || '#6d28d9',
      accent2: normHex(p.accent2) || '#0e7490',
      bg: normHex(p.bg) || '#f7f4ec',
      surface: normHex(p.surface) || '#ffffff',
      ink: normHex(p.ink) || '#211d15'
    };
    syncInputs();
  }

  function setPalette(p, opts) {
    renderPalette(p);
    applyPalette(state.palette);
    setStatus(opts && opts.status);
    markPresetActive(opts && opts.preset);
  }

  function setStatus(kind) {
    var s = document.getElementById('tbStatus');
    if (!s) return;
    if (kind === 'saved') { s.textContent = 'Custom theme saved for this key.'; s.dataset.state = 'saved'; }
    else if (kind === 'draft') { s.textContent = 'Previewing — Apply to save it for this key.'; s.dataset.state = 'draft'; }
    else if (kind === 'default') { s.textContent = 'Using the default theme.'; s.dataset.state = 'default'; }
    else { s.textContent = ''; s.dataset.state = ''; }
    state.saved = (kind === 'saved');
  }

  function markPresetActive(preset) {
    var btns = document.querySelectorAll('.tb-preset');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', !!preset && btns[i].dataset.preset === preset.name);
    }
  }

  function syncInputs() {
    var p = state.palette;
    if (!p) return;
    FIELDS.forEach(function (f) {
      var refs = state.inputs[f.key];
      if (!refs) return;
      refs.color.value = p[f.key];
      refs.hex.value = p[f.key];
    });
  }

  function onFieldInput(key, value) {
    var hex = normHex(value);
    if (!hex) return;
    state.palette[key] = hex;
    var refs = state.inputs[key];
    if (refs) { refs.color.value = hex; if (document.activeElement !== refs.hex) refs.hex.value = hex; }
    applyPalette(state.palette);
    setStatus('draft');
    markPresetActive(null);
  }

  function defaultsFromComputed() {
    var cs = window.getComputedStyle(document.documentElement);
    function gv(name, fb) {
      var v = (cs.getPropertyValue(name) || '').trim();
      return normHex(v) || fb;
    }
    return {
      accent: gv('--acc', '#6d28d9'),
      accent2: gv('--acc2', '#0e7490'),
      bg: gv('--bg', '#f7f4ec'),
      surface: gv('--panel', '#ffffff'),
      ink: gv('--ink', '#211d15')
    };
  }

  function doApply() {
    var ok = saveCurrent(state.palette);
    setStatus(ok ? 'saved' : 'draft');
    if (!ok) {
      var s = document.getElementById('tbStatus');
      if (s) s.textContent = 'Could not save (storage unavailable) — preview only.';
    }
  }

  function doReset() {
    clearSaved();
    clearVars();
    /* restore the legacy accent picker's saved accent, if any */
    try {
      if (window.Hygiene && typeof window.Hygiene.initAccent === 'function') window.Hygiene.initAccent();
    } catch (e) {}
    /* NOTE: reset shows the base-theme defaults in the pickers but writes NO
       inline variables, so the Light / Dark / System mode rules take over. */
    renderPalette(defaultsFromComputed());
    setStatus('default');
    markPresetActive(null);
  }

  function buildCard() {
    var host = document.getElementById('view-settings');
    if (!host || document.getElementById('tbCard')) return;

    var card = el('div', 'card tb-card');
    card.id = 'tbCard';

    card.appendChild(el('h3', null, 'Theme builder'));
    var sub = el('p', 'dim', 'Build a custom color theme from your brand colors. ' +
      'Overrides apply on top of your Light / Dark / System mode, and each API key keeps its own theme.');
    card.appendChild(sub);

    /* presets */
    var pw = el('div', 'tb-presets');
    PRESETS.forEach(function (pr) {
      var b = el('button', 'tb-preset');
      b.type = 'button';
      b.dataset.preset = pr.name;
      b.title = pr.name + ' — ' + pr.desc;
      b.setAttribute('aria-label', 'Apply ' + pr.name + ' preset');
      var sw = el('span', 'tb-preset-sw');
      sw.style.background =
        'linear-gradient(135deg,' + pr.palette.accent + ' 0%,' + pr.palette.accent2 + ' 52%,' +
        pr.palette.surface + ' 52.5%,' + pr.palette.bg + ' 100%)';
      var dot = el('span', 'tb-preset-dot');
      dot.style.background = pr.palette.ink;
      sw.appendChild(dot);
      b.appendChild(sw);
      var meta = el('span', 'tb-preset-meta');
      meta.appendChild(el('span', 'tb-preset-name', pr.name));
      meta.appendChild(el('span', 'tb-preset-desc dim', pr.desc));
      b.appendChild(meta);
      b.addEventListener('click', function () {
        setPalette(pr.palette, { status: 'draft', preset: pr });
      });
      pw.appendChild(b);
    });
    card.appendChild(pw);

    /* color fields */
    var rows = el('div', 'tb-rows');
    FIELDS.forEach(function (f) {
      var row = el('div', 'tb-row');
      var well = el('input', 'tb-well');
      well.type = 'color';
      well.value = '#000000';
      well.setAttribute('aria-label', f.label);
      var lab = el('div', 'tb-row-lab');
      lab.appendChild(el('div', 'tb-row-name', f.label));
      lab.appendChild(el('div', 'tb-row-desc dim', f.desc));
      var hex = el('input', 'tb-hex mono');
      hex.type = 'text';
      hex.maxLength = 7;
      hex.spellcheck = false;
      hex.setAttribute('aria-label', f.label + ' hex value');
      state.inputs[f.key] = { color: well, hex: hex };
      well.addEventListener('input', function () { onFieldInput(f.key, well.value); });
      hex.addEventListener('input', function () { onFieldInput(f.key, hex.value); });
      hex.addEventListener('change', function () { syncInputs(); });
      row.appendChild(well);
      row.appendChild(lab);
      row.appendChild(hex);
      rows.appendChild(row);
    });
    card.appendChild(rows);

    /* live preview */
    var pv = el('div', 'tb-preview');
    pv.appendChild(el('div', 'tb-preview-cap dim', 'Live preview'));
    var mock = el('div', 'tb-mock');
    var head = el('div', 'tb-mock-head');
    head.appendChild(el('span', 'tb-mock-ava'));
    var ml = el('div', 'tb-mock-lines');
    ml.appendChild(el('i', null));
    ml.appendChild(el('i', 'short'));
    head.appendChild(ml);
    head.appendChild(el('span', 'tb-mock-chip', 'AI agent'));
    mock.appendChild(head);
    mock.appendChild(el('div', 'tb-mock-text', 'This is how your theme looks across the app — cards, buttons, text and status colors update as you pick.'));
    var brow = el('div', 'tb-mock-btnrow');
    var bp = el('button', 'tb-mock-btn primary'); bp.type = 'button'; bp.textContent = 'Call';
    var bg2 = el('button', 'tb-mock-btn ghost'); bg2.type = 'button'; bg2.textContent = 'Cancel';
    brow.appendChild(bp); brow.appendChild(bg2);
    mock.appendChild(brow);
    var srow = el('div', 'tb-mock-status');
    srow.appendChild(el('span', 'tb-mock-ok', '● Connected'));
    srow.appendChild(el('span', 'tb-mock-err', '● Missed'));
    mock.appendChild(srow);
    pv.appendChild(mock);
    card.appendChild(pv);

    /* actions */
    var acts = el('div', 'tb-actions');
    var apply = el('button', 'btn primary'); apply.type = 'button'; apply.textContent = 'Apply';
    var reset = el('button', 'btn ghost'); reset.type = 'button'; reset.textContent = 'Reset to default';
    apply.addEventListener('click', doApply);
    reset.addEventListener('click', doReset);
    acts.appendChild(apply);
    acts.appendChild(reset);
    card.appendChild(acts);

    var status = el('p', 'dim tiny tb-status'); status.id = 'tbStatus';
    card.appendChild(status);

    host.appendChild(card);
  }

  /* ---------- boot ---------- */
  function applySavedTheme() {
    var saved = loadSaved();
    if (saved && saved.palette) setPalette(saved.palette, { status: 'saved' });
  }

  function boot() {
    buildCard();
    var saved = loadSaved();
    if (saved && saved.palette) {
      setPalette(saved.palette, { status: 'saved' });
    } else {
      /* No custom theme: show the base-theme defaults in the pickers but
         write NO inline variables, so Light / Dark / System rules keep working. */
      renderPalette(defaultsFromComputed());
      setStatus('default');
    }
    /* Re-apply once the key gate resolves, in case the active key (and its
       theme) only becomes known after login. init() is idempotent. */
    try {
      if (window.KeyGate && typeof window.KeyGate.init === 'function') {
        window.KeyGate.init().then(function () { applySavedTheme(); }, function () {});
      }
    } catch (e) {}
  }

  /* Apply any saved theme as early as possible (before DOMContentLoaded
     handlers of later scripts run), then re-apply on DOMContentLoaded so a
     saved theme wins over other scripts' accent inits. */
  applySavedTheme();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applySavedTheme(); boot(); });
  } else {
    applySavedTheme();
    boot();
  }

  global.ThemeBuilder = {
    applyPalette: applyPalette,
    reset: doReset,
    currentPalette: currentPalette,
    presets: PRESETS,
    _api: api
  };

})(typeof window !== 'undefined' ? window : this);
