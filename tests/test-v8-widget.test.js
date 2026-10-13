'use strict';
/* tests/test-v8-widget.test.js -- v8 #3 embed widget:
 * src/apiv7_widget.js (GET /api/v8/widget-config) + public/widget.js
 * snippet sanity (dependency-free, no stray script tags). */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var widget = require('../src/apiv7_widget');

var KH1 = 'a'.repeat(64);
var KH2 = 'b'.repeat(64);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v8wid-'));
}

function fakeKeystore(profiles) {
  return { listProfiles: function () { return profiles; } };
}

function mountWith(opts) {
  var calls = [];
  var handler = widget.mount(null, {
    sendJson: function (res, code, obj) { calls.push({ code: code, obj: obj }); },
    dataDir: opts.dataDir,
    keystore: opts.keystore
  });
  return { handler: handler, calls: calls };
}

function get(handler, url) {
  return handler({ method: 'GET', url: url }, {});
}

module.exports = {
  'publicRefFor: deterministic, opaque, prefixed': async function () {
    var r1 = widget.publicRefFor(KH1);
    var r2 = widget.publicRefFor(KH1);
    assert.strictEqual(r1, r2, 'deterministic');
    assert.ok(/^sym_[0-9a-f]{16}$/.test(r1), 'format sym_<16 hex>, got ' + r1);
    assert.ok(r1.indexOf(KH1) === -1, 'does not embed the keyHash');
    assert.notStrictEqual(widget.publicRefFor(KH2), r1, 'different keys differ');
  },

  'resolveKeyHash: finds the right keyHash, null for unknown': async function () {
    var ks = fakeKeystore([{ keyHash: KH1, label: 'Acme' }]);
    var ref = widget.publicRefFor(KH1);
    var hit = widget.resolveKeyHash(ks, ref);
    assert.ok(hit, 'resolved');
    assert.strictEqual(hit.keyHash, KH1);
    assert.strictEqual(widget.resolveKeyHash(ks, 'sym_0000000000000000'), null);
    assert.strictEqual(widget.resolveKeyHash(null, ref), null);
  },

  'handler: ignores non-widget paths': async function () {
    var m = mountWith({ dataDir: tmpDir(), keystore: fakeKeystore([]) });
    var handled = await m.handler({ method: 'GET', url: '/api/v7/custom-agents' }, {});
    assert.strictEqual(handled, false);
    assert.strictEqual(m.calls.length, 0);
  },

  'handler: 400 on missing/malformed ref': async function () {
    var m = mountWith({ dataDir: tmpDir(), keystore: fakeKeystore([]) });
    await get(m.handler, '/api/v8/widget-config');
    assert.strictEqual(m.calls[0].code, 400);
    await get(m.handler, '/api/v8/widget-config?ref=!!!bad!!!');
    assert.strictEqual(m.calls[1].code, 400);
  },

  'handler: 404 on unknown ref': async function () {
    var m = mountWith({ dataDir: tmpDir(), keystore: fakeKeystore([]) });
    await get(m.handler, '/api/v8/widget-config?ref=sym_0123456789abcdef');
    assert.strictEqual(m.calls[0].code, 404);
  },

  'handler: 200 with label fallback name and empty number': async function () {
    var dir = tmpDir();
    var ks = fakeKeystore([{ keyHash: KH1, label: 'Acme Corp' }]);
    var m = mountWith({ dataDir: dir, keystore: ks });
    await get(m.handler, '/api/v8/widget-config?ref=' + widget.publicRefFor(KH1));
    assert.strictEqual(m.calls[0].code, 200);
    assert.deepStrictEqual(m.calls[0].obj, { businessNumber: '', businessName: 'Acme Corp' });
    fs.rmSync(dir, { recursive: true, force: true });
  },

  'handler: per-key override wins over label': async function () {
    var dir = tmpDir();
    var ks = fakeKeystore([{ keyHash: KH1, label: 'Acme Corp' }]);
    widget.saveWidgetConfig(dir, KH1, { businessName: 'Acme Dental', businessNumber: '+15550100099' });
    var m = mountWith({ dataDir: dir, keystore: ks });
    await get(m.handler, '/api/v8/widget-config?ref=' + widget.publicRefFor(KH1));
    assert.strictEqual(m.calls[0].code, 200);
    assert.deepStrictEqual(m.calls[0].obj, {
      businessNumber: '+15550100099',
      businessName: 'Acme Dental'
    });
    fs.rmSync(dir, { recursive: true, force: true });
  },

  'handler: response never leaks key material': async function () {
    var dir = tmpDir();
    var ks = fakeKeystore([{ keyHash: KH1, label: 'Acme Corp' }]);
    var m = mountWith({ dataDir: dir, keystore: ks });
    await get(m.handler, '/api/v8/widget-config?ref=' + widget.publicRefFor(KH1));
    var body = JSON.stringify(m.calls[0].obj);
    assert.ok(body.indexOf(KH1) === -1, 'no keyHash in response');
    assert.deepStrictEqual(Object.keys(m.calls[0].obj).sort(), ['businessName', 'businessNumber']);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  'handler: 405 on non-GET': async function () {
    var m = mountWith({ dataDir: tmpDir(), keystore: fakeKeystore([]) });
    var handled = await m.handler({ method: 'POST', url: '/api/v8/widget-config?ref=x' }, {});
    assert.strictEqual(handled, true);
    assert.strictEqual(m.calls[0].code, 405);
  },

  'public/widget.js: self-contained and safe to embed': async function () {
    var src = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
    assert.ok(src.length < 6144, 'snippet stays small (' + src.length + ' bytes)');
    assert.ok(src.indexOf('</scr' + 'ipt') === -1, 'no closing script tag inside');
    assert.ok(src.indexOf('require(') === -1, 'no CommonJS require');
    assert.ok(src.indexOf('import ') === -1, 'no ES imports');
    assert.ok(src.indexOf('/api/v8/widget-config') !== -1, 'fetches widget config');
    assert.ok(src.indexOf('/widget-call.html?key=') !== -1, 'opens widget-call page with key+line');
    assert.ok(src.indexOf('data-ref') !== -1, 'reads data-ref from its script tag');
  }
};

/* ---------- v8 #4 server-side analytics (src/stats.js computeAnalytics) ---------- */
var computeAnalytics = require('../src/stats').computeAnalytics;

module.exports['computeAnalytics: exact contract shape'] = async function () {
  var calls = [
    { id: 'c1', agentId: 'ava', agentName: 'Ava', startedAt: '2026-10-13T09:10:00.000Z', durationSec: 60 },
    { id: 'c2', agentId: 'ava', agentName: 'Ava', startedAt: '2026-10-13T09:40:00.000Z', durationSec: 120 },
    { id: 'c3', agentId: 'liam', agentName: 'Liam', startedAt: '2026-10-13T14:05:00.000Z', durationSec: 30 }
  ];
  var a = computeAnalytics(calls);
  assert.deepStrictEqual(Object.keys(a).sort(), ['agents', 'totals']);
  assert.deepStrictEqual(Object.keys(a.totals).sort(), ['calls', 'minutes']);
  assert.strictEqual(a.totals.calls, 3);
  assert.strictEqual(a.totals.minutes, 4); // round(210/60)
  assert.strictEqual(a.agents.length, 2);
  assert.deepStrictEqual(Object.keys(a.agents[0]).sort(), ['agentId', 'avgSecs', 'byHour', 'calls', 'name']);
  assert.strictEqual(a.agents[0].agentId, 'ava'); // most calls first
  assert.strictEqual(a.agents[0].calls, 2);
  assert.strictEqual(a.agents[0].avgSecs, 90); // mean(60,120)
  assert.strictEqual(a.agents[0].byHour.length, 24);
  assert.strictEqual(a.agents[0].byHour.reduce(function (s, n) { return s + n; }, 0), 2);
  assert.strictEqual(a.agents[1].name, 'Liam');
  assert.strictEqual(a.agents[1].avgSecs, 30);
};

module.exports['computeAnalytics: empty / invalid inputs give zeroed shape'] = async function () {
  assert.deepStrictEqual(computeAnalytics([]), { agents: [], totals: { calls: 0, minutes: 0 } });
  assert.deepStrictEqual(computeAnalytics(null), { agents: [], totals: { calls: 0, minutes: 0 } });
  assert.deepStrictEqual(computeAnalytics('nope'), { agents: [], totals: { calls: 0, minutes: 0 } });
};

module.exports['computeAnalytics: skips garbage entries, tolerates missing fields'] = async function () {
  var a = computeAnalytics([null, 'x', { agentId: 'ava' }]);
  assert.strictEqual(a.totals.calls, 1);
  assert.strictEqual(a.agents[0].agentId, 'ava');
  assert.strictEqual(a.agents[0].name, 'ava'); // falls back to agentId
  assert.strictEqual(a.agents[0].avgSecs, 0);
  assert.strictEqual(a.agents[0].byHour.reduce(function (s, n) { return s + n; }, 0), 0);
};
