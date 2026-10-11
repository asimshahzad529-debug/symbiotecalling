'use strict';
/* public/avatar.js — deterministic per-agent portrait avatars.
 * No two agents share an avatar: a seeded PRNG (from the agent id) drives
 * the palette shade, decoration placement, pose offset and accessories.
 * Rendered as inline SVG — crisp at any size, zero network, zero quota.
 */
(function (global) {
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shade(hex, amt) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, (n >> 16) + amt));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    var b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  function avatarSVG(agent) {
    var rng = mulberry32(fnv1a(agent.id || 'x'));
    var c1 = agent.color || '#8b5cf6';
    var c2 = shade(c1, -52);
    var uid = 'g' + fnv1a(agent.id || 'x').toString(36);
    var dx = (rng() - 0.5) * 10;                 // head x offset
    var dy = (rng() - 0.5) * 6;                  // head y offset
    var tilt = ((rng() - 0.5) * 10).toFixed(1);   // slight pose tilt
    var acc = Math.floor(rng() * 5);             // accessory variant
    var tone = 26 + Math.floor(rng() * 14);       // silhouette lightness
    var sil = 'rgb(' + tone + ',' + (tone + 3) + ',' + (tone + 10) + ')';
    // decorative soft circles
    var d1x = (rng() * 96).toFixed(0), d1y = (rng() * 96).toFixed(0), d1r = (14 + rng() * 16).toFixed(0);
    var d2x = (rng() * 96).toFixed(0), d2y = (rng() * 96).toFixed(0), d2r = (10 + rng() * 12).toFixed(0);
    var hx = (48 + dx).toFixed(1), hy = (40 + dy).toFixed(1);

    var extra = '';
    if (acc === 1) { // glasses
      extra = '<g stroke="rgba(255,255,255,.85)" stroke-width="2" fill="none">' +
        '<circle cx="' + (48 + dx - 8) + '" cy="' + (38 + dy) + '" r="5.5"/>' +
        '<circle cx="' + (48 + dx + 8) + '" cy="' + (38 + dy) + '" r="5.5"/>' +
        '<line x1="' + (48 + dx - 2.5) + '" y1="' + (38 + dy) + '" x2="' + (48 + dx + 2.5) + '" y2="' + (38 + dy) + '"/></g>';
    } else if (acc === 2) { // hair
      extra = '<path d="M' + (30 + dx) + ',' + (38 + dy) + ' Q' + (48 + dx) + ',' + (8 + dy) + ' ' + (66 + dx) + ',' + (38 + dy) +
        ' L' + (62 + dx) + ',' + (44 + dy) + ' Q' + (48 + dx) + ',' + (22 + dy) + ' ' + (34 + dx) + ',' + (44 + dy) + ' Z" fill="' + shade(c2, -30) + '"/>';
    } else if (acc === 3) { // headset
      extra = '<g stroke="' + sil + '" stroke-width="3.5" fill="none">' +
        '<path d="M' + (28 + dx) + ',' + (42 + dy) + ' Q' + (48 + dx) + ',' + (12 + dy) + ' ' + (68 + dx) + ',' + (42 + dy) + '"/></g>' +
        '<line x1="' + (66 + dx) + '" y1="' + (44 + dy) + '" x2="' + (60 + dx) + '" y2="' + (58 + dy) + '" stroke="' + sil + '" stroke-width="3.5" stroke-linecap="round"/>' +
        '<circle cx="' + (59 + dx) + '" cy="' + (59 + dy) + '" r="2.6" fill="' + sil + '"/>';
    } else if (acc === 4) { // collar notch
      extra = '<path d="M' + (40 + dx) + ',96 L' + (48 + dx) + ',84 L' + (56 + dx) + ',96 Z" fill="rgba(255,255,255,.28)"/>';
    }

    return '<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="avatar">' +
      '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient></defs>' +
      '<rect width="96" height="96" fill="url(#' + uid + ')"/>' +
      '<circle cx="' + d1x + '" cy="' + d1y + '" r="' + d1r + '" fill="rgba(255,255,255,.10)"/>' +
      '<circle cx="' + d2x + '" cy="' + d2y + '" r="' + d2r + '" fill="rgba(255,255,255,.08)"/>' +
      '<circle cx="' + hx + '" cy="' + hy + '" r="26" fill="rgba(255,255,255,.16)"/>' +
      '<g transform="rotate(' + tilt + ' 48 60)">' +
      '<circle cx="' + hx + '" cy="' + hy + '" r="15" fill="' + sil + '"/>' +
      '<path d="M' + (22 + dx) + ',96 Q' + (48 + dx) + ',' + (56 + dy) + ' ' + (74 + dx) + ',96 Z" fill="' + sil + '"/>' +
      '</g>' + extra + '</svg>';
  }

  /* <img> avatar with procedural-SVG fallback if the photo is missing. */
  function avatarHTML(agent) {
    var id = String((agent && agent.id) || 'x').replace(/[^a-z0-9_-]/gi, '');
    var color = (agent && agent.color) || '#8b5cf6';
    return '<img src="avatars/' + id + '.jpg" alt="" loading="lazy" data-color="' + color +
      '" onerror="avatarImgFallback(this)">';
  }
  function avatarImgFallback(img) {
    img.onerror = null;
    var m = String(img.src || '').match(/avatars\/([A-Za-z0-9_-]+)\.jpg/);
    var id = m ? m[1] : 'x';
    var tmp = document.createElement('div');
    tmp.innerHTML = avatarSVG({ id: id, color: img.getAttribute('data-color') || '#8b5cf6' });
    img.replaceWith(tmp.firstChild);
  }

  global.avatarSVG = avatarSVG;
  global.avatarHTML = avatarHTML;
  global.avatarImgFallback = avatarImgFallback;
})(typeof window !== 'undefined' ? window : globalThis);
