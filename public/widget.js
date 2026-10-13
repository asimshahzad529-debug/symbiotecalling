/*! Symbiote Calling embed widget v1 (v8 #3) -- dependency-free.
 *
 * Paste on any website before </body>:
 *
 *   <script src="https://YOUR-APP/widget.js"
 *           data-app="https://YOUR-APP"
 *           data-ref="sym_XXXXXXXXXXXXXXXX"
 *           data-label="Call us">   (close the tag normally)
 *
 * data-app:   URL of your Symbiote Calling app (defaults to page origin).
 * data-ref:   public widget ref from Settings -> Embed widget (no API key
 *             material -- safe to publish in page HTML).
 * data-label: button text (default "Call us").
 * data-pos:   bottom-right | bottom-left (default bottom-right).
 *
 * The snippet fetches /api/v8/widget-config?ref=... for the business name
 * and line, renders a floating button, and opens the call experience
 * (/widget-call.html?key=<ref>&line=<number>) in a popup window.
 */
(function () {
  'use strict';
  var d = document;
  var script = d.currentScript || (function () {
    var s = d.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  function attr(name, def) {
    var v = script && script.getAttribute(name);
    return v != null && v !== '' ? v : def;
  }

  var app = attr('data-app', location.origin).replace(/\/+$/, '');
  var ref = attr('data-ref', '');
  var label = attr('data-label', 'Call us');
  var pos = attr('data-pos', 'bottom-right') === 'bottom-left' ? 'bottom-left' : 'bottom-right';

  function openCall(number, name) {
    var url = app + '/widget-call.html?key=' + encodeURIComponent(ref) +
      '&line=' + encodeURIComponent(number || '');
    var w = 420, h = 640;
    var left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || 900) - w) / 2);
    var top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || 700) - h) / 2);
    window.open(url, 'symbiote_call',
      'width=' + w + ',height=' + h + ',left=' + Math.round(left) +
      ',top=' + Math.round(top) + ',resizable=yes,scrollbars=yes');
  }

  function render(number, name) {
    if (d.getElementById('sym-call-btn')) return;
    var b = d.createElement('button');
    b.id = 'sym-call-btn';
    b.type = 'button';
    b.textContent = label;
    b.title = name ? 'Call ' + name : label;
    var base = 'position:fixed;z-index:2147483647;border:0;cursor:pointer;' +
      'bottom:22px;' + (pos === 'bottom-left' ? 'left:22px;' : 'right:22px;') +
      'font:600 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
      'color:#fff;background:#141414;border-radius:999px;' +
      'padding:13px 20px;box-shadow:0 6px 22px rgba(0,0,0,.28);' +
      'display:flex;align-items:center;gap:8px;';
    b.setAttribute('style', base);
    var dot = d.createElement('span');
    dot.setAttribute('style', 'width:9px;height:9px;border-radius:50%;background:#3ddc84;display:inline-block;');
    b.insertBefore(dot, b.firstChild);
    b.addEventListener('click', function () { openCall(number, name); });
    d.body.appendChild(b);
  }

  function boot() {
    if (!ref) return; // nothing to resolve against; stay invisible
    var done = false;
    function fallback() { if (!done) { done = true; render('', ''); } }
    try {
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort(); else fallback();
      }, 6000);
      var opts = {};
      if (ctrl) opts.signal = ctrl.signal;
      fetch(app + '/api/v8/widget-config?ref=' + encodeURIComponent(ref), opts)
        .then(function (r) {
          clearTimeout(timer);
          if (!r.ok) throw new Error('bad config');
          return r.json();
        })
        .then(function (c) {
          done = true;
          render(c && c.businessNumber || '', c && c.businessName || '');
        })
        .catch(fallback);
    } catch (e) { fallback(); }
  }

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
