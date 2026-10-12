'use strict';
/* tests/test-v7-ws1-keygate.test.js — v7 WS1 key gating.
 * Storage migration (per-keyHash partitions), src/keystore.js (profiles,
 * usage metering, rate limiter, audit), src/apiv7_keygate.js routes, and the
 * window.KeyGate client (login overlay gating, apiFetch, switcher). */
var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');

var storeMod = require('../src/store');
var memoryMod = require('../src/memory');
var keystoreMod = require('../src/keystore');
var keygateMod = require('../src/apiv7_keygate');

var KH_A = 'a'.repeat(64), KH_B = 'b'.repeat(64), KH_C = 'c'.repeat(64);

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ws1-keygate-')); }
function settle() {
  var p = Promise.resolve();
  for (var i = 0; i < 6; i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}

/* ---------------- API harness ---------------- */

function makeCtx(dir) {
  var ks = new keystoreMod.KeyStore(dir);
  var ctx = {
    sendJson: function (res, code, obj) { res.statusCode = code; res.body = obj; },
    readBody: function (req) { return Promise.resolve(req._body == null ? '' : req._body); },
    dataDir: dir,
    keystore: ks,
    keyHashOf: function (k) { return crypto.createHash('sha256').update(String(k)).digest('hex'); }
  };
  ctx._ks = ks;
  return ctx;
}

function mountApi(ctx) {
  var api = keygateMod.createApi();
  keygateMod.mount(api, ctx);
  return api;
}

function fakeReq(method, url, headers, body) {
  return { method: method, url: url, headers: headers || {}, _body: body };
}

/* ---------------- tiny DOM shim for public/keygate.js ---------------- */

function FakeEl(tag) {
  this.tagName = (tag || 'div').toUpperCase();
  this.children = [];
  this.parentNode = null;
  this.className = '';
  this.textContent = '';
  this.value = '';
  this.type = '';
  this.placeholder = '';
  this.href = '';
  this.target = '';
  this.rel = '';
  this.disabled = false;
  this.hidden = false;
  this._attrs = {};
  this._listeners = {};
  var self = this;
  this.classList = {
    add: function (c) {
      var s = self.className.split(' ').filter(function (x) { return x; });
      if (s.indexOf(c) === -1) s.push(c);
      self.className = s.join(' ');
    },
    remove: function (c) {
      self.className = self.className.split(' ').filter(function (x) { return x && x !== c; }).join(' ');
    },
    contains: function (c) { return self.className.split(' ').indexOf(c) !== -1; },
    toggle: function (c) { if (this.contains(c)) this.remove(c); else this.add(c); }
  };
  Object.defineProperty(this, 'innerHTML', {
    get: function () { return ''; },
    set: function () { self.children = []; },
    configurable: true
  });
}
FakeEl.prototype.appendChild = function (c) { c.parentNode = this; this.children.push(c); return c; };
FakeEl.prototype.removeChild = function (c) {
  var i = this.children.indexOf(c);
  if (i !== -1) this.children.splice(i, 1);
  c.parentNode = null;
  return c;
};
FakeEl.prototype.addEventListener = function (t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); };
FakeEl.prototype.click = function () {
  var fns = this._listeners.click || [];
  for (var i = 0; i < fns.length; i++) fns[i].call(this, { target: this });
};
FakeEl.prototype.setAttribute = function (k, v) { this._attrs[k] = String(v); };
FakeEl.prototype.getAttribute = function (k) { return this._attrs[k]; };
FakeEl.prototype.focus = function () {};
function selMatches(elm, sel) {
  if (sel.charAt(0) === '.') return elm.className.split(' ').indexOf(sel.slice(1)) !== -1;
  if (sel.charAt(0) === '#') return elm._attrs.id === sel.slice(1);
  return elm.tagName === sel.toUpperCase();
}
FakeEl.prototype.querySelector = function (sel) {
  for (var i = 0; i < this.children.length; i++) {
    var c = this.children[i];
    if (selMatches(c, sel)) return c;
    var d = c.querySelector(sel);
    if (d) return d;
  }
  return null;
};
FakeEl.prototype.querySelectorAll = function (sel) {
  var out = [];
  (function walk(n) {
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (selMatches(c, sel)) out.push(c);
      walk(c);
    }
  })(this);
  return out;
};

function loadKeyGate(seed) {
  var storage = {};
  var localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
    setItem: function (k, v) { storage[k] = String(v); },
    removeItem: function (k) { delete storage[k]; }
  };
  if (seed) {
    if (seed.keys) localStorage.setItem('symbiote-keys-v1', JSON.stringify(seed.keys));
    if (seed.active) localStorage.setItem('symbiote-active-key-v1', seed.active);
  }
  var body = new FakeEl('body');
  var document = {
    createElement: function (t) { return new FakeEl(t); },
    body: body,
    getElementById: function () { return null; }
  };
  var fetched = [];
  var win = {
    crypto: crypto.webcrypto,
    localStorage: localStorage,
    fetch: function (url, o) {
      fetched.push({ url: url, opts: o || {} });
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
    }
  };
  var sandbox = { console: console, document: document, TextEncoder: TextEncoder, window: win };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'keygate.js'), 'utf8'),
    sandbox, { filename: 'keygate.js' });
  return { KeyGate: win.KeyGate, localStorage: localStorage, body: body, fetched: fetched, storage: storage };
}

function khOf(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }

/* ---------------- tests ---------------- */

module.exports = {

  /* --- storage migration: per-keyHash partitions --- */

  'storage: two keyHashes get separate data, switching back is intact, no wipe': async function () {
    var dir = tmpdir();
    var hA = new storeMod.CallHistory(dir, KH_A);
    var mA = new memoryMod.MemoryStore(dir, KH_A);
    var callId = await hA.logStart({ agentId: 'ava', agentName: 'Ava', number: 'x' });
    await hA.logEnd(callId);
    var memId = await mA.beginCall({ keyHash: KH_A, agentId: 'ava', agentName: 'Ava', number: 'x' });
    await mA.endCall(memId);

    var hB = new storeMod.CallHistory(dir, KH_B);
    var mB = new memoryMod.MemoryStore(dir, KH_B);
    assert.strictEqual(hB.list().length, 0, 'key B history starts empty');
    assert.strictEqual(mB.list(KH_B).length, 0, 'key B memories start empty');
    assert.strictEqual((await mB.ensureScope(KH_B)).reset, false, 'no wipe on switch');

    await hB.logStart({ agentId: 'marco', agentName: 'Marco', number: 'y' });

    var hA2 = new storeMod.CallHistory(dir, KH_A);
    var mA2 = new memoryMod.MemoryStore(dir, KH_A);
    assert.strictEqual(hA2.list().length, 1, 'key A history intact after switch');
    assert.strictEqual(mA2.list(KH_A).length, 1, 'key A memories intact after switch');
    assert.strictEqual(new storeMod.CallHistory(dir, KH_B).list().length, 1, 'key B wrote its own partition');
    assert.ok(fs.existsSync(path.join(dir, 'calls_' + KH_A + '.json')));
    assert.ok(fs.existsSync(path.join(dir, 'memories_' + KH_B + '.json')));
  },

  'storage: isValidKeyHash accepts 64 hex, rejects everything else': async function () {
    assert.ok(keystoreMod.isValidKeyHash(KH_A));
    assert.ok(!keystoreMod.isValidKeyHash('xyz'));
    assert.ok(!keystoreMod.isValidKeyHash('a'.repeat(63)));
    assert.ok(!keystoreMod.isValidKeyHash('a'.repeat(65)));
    assert.ok(!keystoreMod.isValidKeyHash('g'.repeat(64)), 'g is not hex');
    assert.ok(!keystoreMod.isValidKeyHash(null));
    assert.ok(!keystoreMod.isValidKeyHash(42));
    assert.strictEqual(keystoreMod.normalizeKeyHash('A'.repeat(64)), 'a'.repeat(64), 'upper normalized');
    assert.throws(function () { keystoreMod.normalizeKeyHash('nope'); }, /64 hex/);
  },

  /* --- keystore: profiles --- */

  'keystore: profiles add/list/remove round-trip': async function () {
    var ks = new keystoreMod.KeyStore(tmpdir());
    assert.deepStrictEqual(ks.listProfiles(), []);
    var p1 = await ks.addProfile(KH_A, 'Work');
    assert.strictEqual(p1.keyHash, KH_A);
    assert.strictEqual(p1.label, 'Work');
    assert.ok(p1.createdAt);
    await ks.addProfile(KH_B, 'Personal');
    var all = ks.listProfiles();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].label, 'Work', 'oldest first');
    // upsert same hash: relabel, no duplicate
    await ks.addProfile(KH_A, 'Work renamed');
    all = ks.listProfiles();
    assert.strictEqual(all.length, 2);
    assert.strictEqual(all[0].label, 'Work renamed');
    // raw key must never be persisted
    var raw = fs.readFileSync(ks.profilesFile, 'utf8');
    assert.ok(raw.indexOf('super-secret') === -1);
    assert.strictEqual(await ks.removeProfile(KH_A), true);
    assert.strictEqual(ks.listProfiles().length, 1);
    assert.strictEqual(await ks.removeProfile(KH_A), false, 'idempotent');
    assert.throws(function () { ks.getUsage('junk'); }, /64 hex/);
    await assert.rejects(ks.addProfile('junk', 'x'), /64 hex/);
  },

  /* --- keystore: usage metering --- */

  'keystore: usage metering counts calls and minutes': async function () {
    var ks = new keystoreMod.KeyStore(tmpdir());
    assert.deepStrictEqual(ks.getUsage(KH_A), { calls: 0, minutes: 0 });
    await ks.recordCall(KH_A, 2.5);
    await ks.recordCall(KH_A, 1.5);
    assert.deepStrictEqual(ks.getUsage(KH_A), { calls: 2, minutes: 4 });
    assert.deepStrictEqual(ks.getUsage(KH_B), { calls: 0, minutes: 0 }, 'per-key metering');
    await ks.recordCall(KH_A, -3);
    assert.strictEqual(ks.getUsage(KH_A).minutes, 4, 'negative minutes clamp to 0');
    assert.throws(function () { ks.getUsage('nope'); }, /64 hex/);
    await assert.rejects(ks.recordCall('nope', 1), /64 hex/);
  },

  /* --- keystore: rate limiter --- */

  'keystore: rate limiter admits 3 concurrent, rejects 4th, release frees': async function () {
    var ks = new keystoreMod.KeyStore(tmpdir());
    assert.ok(ks.tryAcquire(KH_A));
    assert.ok(ks.tryAcquire(KH_A));
    assert.ok(ks.tryAcquire(KH_A));
    assert.strictEqual(ks.tryAcquire(KH_A), false, '4th concurrent call rejected');
    assert.strictEqual(ks.activeCalls(KH_A), 3);
    assert.strictEqual(ks.release(KH_A), 2);
    assert.ok(ks.tryAcquire(KH_A), 'slot freed after release');
    ks.release(KH_A); ks.release(KH_A); ks.release(KH_A);
    assert.strictEqual(ks.activeCalls(KH_A), 0);
    assert.strictEqual(ks.release(KH_A), 0, 'release never goes negative');
  },

  'keystore: rate limiter is per-key and maxConcurrent is configurable': async function () {
    var ks = new keystoreMod.KeyStore(tmpdir(), { maxConcurrent: 1 });
    assert.ok(ks.tryAcquire(KH_A));
    assert.strictEqual(ks.tryAcquire(KH_A), false, 'custom max 1 enforced');
    assert.ok(ks.tryAcquire(KH_B), 'other key unaffected');
    ks.release(KH_A); ks.release(KH_B);
    assert.throws(function () { ks.tryAcquire('garbage'); }, /64 hex/);
    assert.throws(function () { ks.release('garbage'); }, /64 hex/);
  },

  /* --- keystore: audit --- */

  'keystore: audit append/list is newest-first with all fields': async function () {
    var ks = new keystoreMod.KeyStore(tmpdir());
    assert.deepStrictEqual(ks.auditList(), []);
    await ks.audit({ keyHash: KH_A, label: 'Work', event: 'login', agentId: null });
    await ks.audit({ keyHash: KH_A, label: 'Work', event: 'call_start', agentId: 'ava' });
    var entries = ks.auditList();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].event, 'call_start', 'newest first');
    assert.strictEqual(entries[1].event, 'login');
    assert.strictEqual(entries[0].keyHash, KH_A);
    assert.strictEqual(entries[0].label, 'Work');
    assert.strictEqual(entries[0].agentId, 'ava');
    assert.ok(entries[0].t);
    assert.strictEqual(ks.auditList(1).length, 1, 'limit honored');
    await assert.rejects(ks.audit({ keyHash: 'bad', event: 'x' }), /64 hex/);
  },

  /* --- API routes --- */

  'api: profiles CRUD': async function () {
    var ctx = makeCtx(tmpdir());
    var api = mountApi(ctx);
    var r = fakeReq('GET', '/api/v7/key/profiles');
    var s = {};
    assert.strictEqual(api.handle(r, s), true);
    assert.strictEqual(s.statusCode, 200);
    assert.deepStrictEqual(s.body.profiles, []);

    r = fakeReq('POST', '/api/v7/key/profiles', { 'content-type': 'application/json' },
      JSON.stringify({ keyHash: KH_A, label: 'Work' }));
    s = {};
    api.handle(r, s);
    await settle();
    assert.strictEqual(s.statusCode, 200);
    assert.strictEqual(s.body.ok, true);

    r = fakeReq('GET', '/api/v7/key/profiles');
    s = {};
    api.handle(r, s);
    assert.strictEqual(s.body.profiles.length, 1);
    assert.strictEqual(s.body.profiles[0].label, 'Work');

    r = fakeReq('DELETE', '/api/v7/key/profiles/' + KH_A);
    s = {};
    api.handle(r, s);
    await settle();
    assert.strictEqual(s.statusCode, 200);
    assert.strictEqual(s.body.ok, true);

    r = fakeReq('GET', '/api/v7/key/profiles');
    s = {};
    api.handle(r, s);
    assert.deepStrictEqual(s.body.profiles, []);
  },

  'api: keyHash validation rejects garbage on every input': async function () {
    var ctx = makeCtx(tmpdir());
    var api = mountApi(ctx);
    var cases = [
      fakeReq('POST', '/api/v7/key/profiles', {}, JSON.stringify({ keyHash: 'xyz', label: 'x' })),
      fakeReq('POST', '/api/v7/key/profiles', {}, JSON.stringify({ keyHash: 'a'.repeat(63), label: 'x' })),
      fakeReq('POST', '/api/v7/key/profiles', {}, 'not json{{'),
      fakeReq('DELETE', '/api/v7/key/profiles/not-a-hash'),
      fakeReq('GET', '/api/v7/key/usage', { 'x-key-hash': 'garbage' }),
      fakeReq('GET', '/api/v7/key/usage?keyHash=short', {}),
      fakeReq('GET', '/api/v7/audit', { 'x-key-hash': 'zzz' })
    ];
    for (var i = 0; i < cases.length; i++) {
      var s = {};
      api.handle(cases[i], s);
      await settle();
      assert.strictEqual(s.statusCode, 400, 'case ' + i + ' must be 400, got ' + s.statusCode);
      assert.ok(s.body && s.body.error, 'case ' + i + ' carries an error');
    }
    // missing key entirely -> 401 login required
    var s2 = {};
    api.handle(fakeReq('GET', '/api/v7/key/usage', {}), s2);
    assert.strictEqual(s2.statusCode, 401);
    // uppercase hex is normalized, not rejected
    var s3 = {};
    api.handle(fakeReq('GET', '/api/v7/key/usage', { 'x-key-hash': 'A'.repeat(64) }), s3);
    assert.strictEqual(s3.statusCode, 200);
    assert.deepStrictEqual(s3.body, { calls: 0, minutes: 0 });
  },

  'api: usage reflects recorded calls for the caller key': async function () {
    var ctx = makeCtx(tmpdir());
    var api = mountApi(ctx);
    await ctx._ks.recordCall(KH_A, 3);
    await ctx._ks.recordCall(KH_A, 2);
    await ctx._ks.recordCall(KH_B, 10);
    var s = {};
    api.handle(fakeReq('GET', '/api/v7/key/usage', { 'x-key-hash': KH_A }), s);
    assert.strictEqual(s.statusCode, 200);
    assert.deepStrictEqual(s.body, { calls: 2, minutes: 5 });
    // query-param fallback also works
    var s2 = {};
    api.handle(fakeReq('GET', '/api/v7/key/usage?keyHash=' + KH_B, {}), s2);
    assert.strictEqual(s2.statusCode, 200);
    assert.deepStrictEqual(s2.body, { calls: 1, minutes: 10 });
  },

  'api: audit endpoint requires login and returns recent entries': async function () {
    var ctx = makeCtx(tmpdir());
    var api = mountApi(ctx);
    await ctx._ks.audit({ keyHash: KH_A, label: 'Work', event: 'login', agentId: null });
    await ctx._ks.audit({ keyHash: KH_A, label: 'Work', event: 'call_end', agentId: 'marco' });
    var s = {};
    api.handle(fakeReq('GET', '/api/v7/audit', { 'x-key-hash': KH_A }), s);
    assert.strictEqual(s.statusCode, 200);
    assert.strictEqual(s.body.entries.length, 2);
    assert.strictEqual(s.body.entries[0].event, 'call_end');
    var s2 = {};
    api.handle(fakeReq('GET', '/api/v7/audit', {}), s2);
    assert.strictEqual(s2.statusCode, 401, 'audit is owner-view: login required');
  },

  'api: audit endpoint is per-key — one key never sees another key\'s entries': async function () {
    var ctx = makeCtx(tmpdir());
    var api = mountApi(ctx);
    await ctx._ks.audit({ keyHash: KH_A, label: 'Work', event: 'call_start', agentId: 'ava' });
    await ctx._ks.audit({ keyHash: KH_B, label: 'Home', event: 'call_start', agentId: 'marco' });
    await ctx._ks.audit({ keyHash: KH_B, label: 'Home', event: 'call_end', agentId: 'marco' });
    var sA = {};
    api.handle(fakeReq('GET', '/api/v7/audit', { 'x-key-hash': KH_A }), sA);
    assert.strictEqual(sA.statusCode, 200);
    assert.strictEqual(sA.body.entries.length, 1, 'key A sees only its own entry');
    assert.strictEqual(sA.body.entries[0].keyHash, KH_A);
    var sB = {};
    api.handle(fakeReq('GET', '/api/v7/audit', { 'x-key-hash': KH_B }), sB);
    assert.strictEqual(sB.statusCode, 200);
    assert.strictEqual(sB.body.entries.length, 2, 'key B sees its two entries');
    assert.ok(sB.body.entries.every(function (e) { return e.keyHash === KH_B; }));
  },

  'api: unknown v7 path is not handled': async function () {
    var ctx = makeCtx(tmpdir());
    var api = mountApi(ctx);
    var s = {};
    assert.strictEqual(api.handle(fakeReq('GET', '/api/v7/key/nope', {}), s), false);
    assert.strictEqual(api.handle(fakeReq('POST', '/api/v7/key/profiles', {}), {}), true, 'method+path match');
  },

  /* --- client: window.KeyGate --- */

  'client: no stored key -> login overlay shows and main UI is gated': async function () {
    var env = loadKeyGate();
    var KeyGate = env.KeyGate;
    var readyP = KeyGate.init();
    assert.ok(env.body.classList.contains('kg-gated'), 'body gated');
    var overlay = env.body.querySelector('.kg-overlay');
    assert.ok(overlay, 'login overlay shown');
    assert.ok(overlay.querySelector('.kg-key-input'), 'key input present');
    assert.ok(overlay.querySelector('.kg-unlock'), 'unlock button present');
    assert.strictEqual(KeyGate.getKey(), null, 'no key before login');

    overlay.querySelector('.kg-key-input').value = 'TEST-KEY-1';
    overlay.querySelector('.kg-label-input').value = 'Work';
    overlay.querySelector('.kg-unlock').click();
    var res = await readyP;
    assert.strictEqual(res.key, 'TEST-KEY-1');
    assert.strictEqual(KeyGate.getKey(), 'TEST-KEY-1');
    assert.ok(!env.body.classList.contains('kg-gated'), 'gate lifted after login');
    assert.strictEqual(env.body.querySelector('.kg-overlay'), null, 'overlay removed');
    var stored = JSON.parse(env.localStorage.getItem('symbiote-keys-v1'));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].label, 'Work');
    assert.strictEqual(stored[0].key, 'TEST-KEY-1');
    assert.strictEqual(stored[0].keyHash, khOf('TEST-KEY-1'));
  },

  'client: stored key logs in automatically, no overlay': async function () {
    var kh = khOf('K2');
    var env = loadKeyGate({
      keys: [{ label: 'Main', key: 'K2', keyHash: kh }],
      active: 'Main'
    });
    var res = await env.KeyGate.init();
    assert.strictEqual(res.key, 'K2');
    assert.strictEqual(res.fresh, false);
    assert.strictEqual(env.body.querySelector('.kg-overlay'), null, 'no overlay for known key');
    assert.ok(!env.body.classList.contains('kg-gated'));
  },

  'client: getKeyHash is sha256 hex; apiFetch attaches header, never URL': async function () {
    var env = loadKeyGate({
      keys: [{ label: 'Main', key: 'K2', keyHash: khOf('K2') }],
      active: 'Main'
    });
    await env.KeyGate.init();
    var kh = await env.KeyGate.getKeyHash();
    assert.strictEqual(kh, khOf('K2'));
    assert.ok(/^[0-9a-f]{64}$/.test(kh));
    await env.KeyGate.apiFetch('/api/v7/key/usage');
    assert.strictEqual(env.fetched.length, 1);
    assert.strictEqual(env.fetched[0].url, '/api/v7/key/usage', 'no key material in URL');
    assert.strictEqual(env.fetched[0].opts.headers['x-key-hash'], kh, 'hash attached as header');
  },

  'client: login registers the profile server-side via apiFetch': async function () {
    var env = loadKeyGate();
    var readyP = env.KeyGate.init();
    env.body.querySelector('.kg-key-input').value = 'KEY-XYZ';
    env.body.querySelector('.kg-unlock').click();
    await readyP;
    await settle();
    var posts = env.fetched.filter(function (f) { return f.url === '/api/v7/key/profiles'; });
    assert.strictEqual(posts.length, 1, 'one profile POST');
    assert.strictEqual(posts[0].opts.method, 'POST');
    assert.strictEqual(posts[0].opts.headers['x-key-hash'], khOf('KEY-XYZ'));
    var body = JSON.parse(posts[0].opts.body);
    assert.strictEqual(body.keyHash, khOf('KEY-XYZ'));
    assert.ok(body.label, 'label sent');
    assert.ok(posts[0].url.indexOf('KEY-XYZ') === -1, 'raw key never in URL');
  },

  'client: switcher lists profiles, switches and deletes': async function () {
    var env = loadKeyGate();
    var KeyGate = env.KeyGate;
    var readyP = KeyGate.init();
    env.body.querySelector('.kg-key-input').value = 'KEY-ONE';
    env.body.querySelector('.kg-unlock').click();
    await readyP;
    await KeyGate.login('KEY-TWO', 'Second');
    assert.strictEqual(KeyGate.getKey(), 'KEY-TWO');

    var modal = KeyGate.openSwitcher(env.body);
    assert.ok(env.body.querySelector('.kg-modal'), 'switcher modal shown');
    assert.strictEqual(modal.querySelectorAll('.kg-profile-row').length, 2, 'both profiles listed');

    // switch back to the first profile via its Switch button
    var rows = modal.querySelectorAll('.kg-profile-row');
    var switchBtn = rows[0].querySelector('.kg-btn');
    assert.strictEqual(switchBtn.textContent, 'Switch');
    switchBtn.click();
    assert.strictEqual(KeyGate.getKey(), 'KEY-ONE', 'switched profile');
    assert.strictEqual(env.body.querySelector('.kg-modal'), null, 'modal closed after switch');

    // delete the non-active profile
    var delRes = await KeyGate.deleteProfile('Second');
    assert.strictEqual(delRes, true);
    var stored = JSON.parse(env.localStorage.getItem('symbiote-keys-v1'));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].label, 'Key 1');
    var dels = env.fetched.filter(function (f) {
      return f.opts.method === 'DELETE' && f.url.indexOf('/api/v7/key/profiles/') === 0;
    });
    assert.strictEqual(dels.length, 1, 'server-side DELETE issued');
    assert.ok(dels[0].url.endsWith(khOf('KEY-TWO')), 'delete targets the keyHash');
  }
};
