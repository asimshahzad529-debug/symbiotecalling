'use strict';
/* tests/test-v7-ws7-isolation.test.js — v7.5 per-key isolation + reactivity.
 *
 * Regression: a custom agent created under API key 1 must NEVER appear
 * under key 2 — asserted across every read path: the custom-agent store,
 * the directory merge (built-ins + custom), server dial-by-number
 * resolution (bridge.resolveAgent), stats top-agents, dialer recents, and
 * SymAgent's agent directory section.
 *
 * Also covers the v7.5 reactivity contract (public/custom-events.js): the
 * `custom-agents-changed` event flow is exercised on the pure channel in
 * node. BROWSER-ONLY parts (not exercised here — no DOM in node):
 *   - the DOM CustomEvent dispatch inside CustomAgentChannel.emit
 *     (guarded by typeof window; never runs in node)
 *   - notifyChanged() emission inside public/custom-agents.js buildForm /
 *     delete handlers (fires after real API success in the browser)
 *   - app.js's window.addEventListener('custom-agents-changed', ...) and
 *     the directory re-render / dialer refresh it triggers
 *   - the dialer's live filtering (renderDialMatches over the merged AGENTS
 *     list) — the merged list itself IS asserted here
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var bridgeMod = require('../src/bridge');
var storeMod = require('../src/store');
var statsMod = require('../src/stats');
var customAgents = require('../src/customAgents');
var customEvents = require('../public/custom-events');
var clientCustom = require('../public/custom-agents'); // pure mergeAgentLists only
var CallX = require('../public/callx.js');

var KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64);
var BUILTIN = [{ id: 'ava', name: 'Ava', number: '+1 (555) 010-0001' }];

function tmpdir(pfx) { return fs.mkdtempSync(path.join(os.tmpdir(), pfx || 'ws7-iso-')); }
function mockStorage() {
  var map = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; }
  };
}
function validCustom() {
  return { name: 'Zed Iso', number: '+92 300 1234567', role: 'Isolation Tester', tone: 'friendly', voice: 'Charon', prompt: 'Be helpful.' };
}
function MockWs() { this.handlers = {}; this.sent = []; this.closed = false; }
MockWs.prototype.on = function (ev, fn) { this.handlers[ev] = fn; };
MockWs.prototype.send = function (data) { this.sent.push(JSON.parse(data)); };
MockWs.prototype.close = function () { this.closed = true; };
function bridgeFor(dir) {
  var ws = new MockWs();
  var b = new bridgeMod.Bridge(ws, {
    history: new storeMod.CallHistory(dir),
    memory: null,
    sdk: null, envKey: null,
    customStore: new customAgents.CustomAgentStore(dir),
    dataDir: dir
  });
  return b;
}

module.exports = {
  /* ---------- event channel (pure, node-testable) ---------- */

  'events: CHANGED_EVENT name': function () {
    assert.strictEqual(customEvents.CHANGED_EVENT, 'custom-agents-changed');
  },

  'events: subscribe -> emit delivers detail to handlers': function () {
    var ch = new customEvents.CustomAgentChannel();
    var seen = [];
    ch.subscribe(function (d) { seen.push(d); });
    ch.subscribe(function (d) { seen.push(d.action); });
    var n = ch.emit({ action: 'created', id: 'custom_x' });
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(seen[0], { action: 'created', id: 'custom_x' });
    assert.strictEqual(seen[1], 'created');
  },

  'events: unsubscribe stops delivery; subscribe rejects non-functions': function () {
    var ch = new customEvents.CustomAgentChannel();
    var count = 0;
    var off = ch.subscribe(function () { count++; });
    assert.strictEqual(ch.handlerCount(), 1);
    off();
    assert.strictEqual(ch.handlerCount(), 0);
    ch.emit({ action: 'created' });
    assert.strictEqual(count, 0, 'no delivery after unsubscribe');
    assert.throws(function () { ch.subscribe('nope'); }, /function/);
  },

  'events: a throwing handler does not break the others or the emitter': function () {
    var ch = new customEvents.CustomAgentChannel();
    var ok = [];
    ch.subscribe(function () { throw new Error('bad handler'); });
    ch.subscribe(function (d) { ok.push(d.action); });
    assert.doesNotThrow(function () { ch.emit({ action: 'deleted' }); });
    assert.deepStrictEqual(ok, ['deleted']);
  },

  'events: singleton emitChanged/onChanged share the channel': function () {
    var seen = [];
    var off = customEvents.onChanged(function (d) { seen.push(d); });
    customEvents.emitChanged({ action: 'updated', id: 'custom_y' });
    assert.deepStrictEqual(seen, [{ action: 'updated', id: 'custom_y' }]);
    off();
    // NOTE (browser-only): the DOM CustomEvent('custom-agents-changed')
    // dispatch inside emit() is guarded by typeof window and never runs in
    // node; the browser path is covered by manual/integration testing.
  },

  /* ---------- per-key isolation: one surface per test ---------- */

  'isolation: store reads are per-key (create under A invisible under B)': async function () {
    var s = new customAgents.CustomAgentStore(tmpdir());
    var rec = await s.create(KEY_A, validCustom());
    assert.deepStrictEqual(s.list(KEY_B), [], 'B lists nothing');
    assert.strictEqual(s.get(KEY_B, rec.id), null, 'B cannot get by id');
    await assert.rejects(s.update(KEY_B, rec.id, validCustom()), /not found/i);
    await assert.rejects(s.remove(KEY_B, rec.id), /not found/i);
    assert.strictEqual(s.list(KEY_A).length, 1, 'A still has it');
  },

  'isolation: directory merge (built-ins + custom) is per-key': async function () {
    var s = new customAgents.CustomAgentStore(tmpdir());
    var rec = await s.create(KEY_A, validCustom());
    var mergedA = clientCustom.mergeAgentLists(BUILTIN, s.list(KEY_A));
    var mergedB = clientCustom.mergeAgentLists(BUILTIN, s.list(KEY_B));
    assert.ok(mergedA.some(function (a) { return a.id === rec.id; }), 'A merged list contains it');
    assert.ok(!mergedB.some(function (a) { return a.id === rec.id; }), 'B merged list does not');
    assert.strictEqual(mergedB.length, BUILTIN.length, 'B sees built-ins only');
  },

  'isolation: server dial-by-number resolves the ACTIVE key custom agent only': async function () {
    var dir = tmpdir();
    var s = new customAgents.CustomAgentStore(dir);
    var rec = await s.create(KEY_A, validCustom());
    var b = bridgeFor(dir);
    b.keyHash = KEY_A;
    var hit = b.resolveAgent({ number: '+92 300 1234567' });
    assert.ok(hit && hit.id === rec.id, 'dial-by-number under key A resolves the custom agent');
    assert.strictEqual(hit.isCustom, true);
    b.keyHash = KEY_B;
    assert.strictEqual(b.resolveAgent({ number: '+92 300 1234567' }), null,
      'same number under key B resolves to nothing (no cross-key dial)');
    // built-ins still resolve for both keys
    b.keyHash = KEY_B;
    var builtin = b.resolveAgent({ number: '+1 (555) 010-0001' });
    assert.ok(builtin && builtin.id === 'ava', 'built-in numbers resolve under any key');
    // unknown custom id under the owning key -> null (not-in-service)
    b.keyHash = KEY_A;
    assert.strictEqual(b.resolveAgent({ number: '0300 0000000' }), null);
  },

  'isolation: stats top-agents reflect only the key partition': async function () {
    var dir = tmpdir();
    var s = new customAgents.CustomAgentStore(dir);
    var rec = await s.create(KEY_A, validCustom());
    var hA = new storeMod.CallHistory(dir, KEY_A);
    var hB = new storeMod.CallHistory(dir, KEY_B);
    var id = await hA.logStart({ agentId: rec.id, agentName: rec.name, number: rec.number });
    await hA.logEnd(id);
    var statsA = statsMod.computeStats(hA.list(), []);
    var statsB = statsMod.computeStats(hB.list(), []);
    assert.strictEqual(statsA.totalCalls, 1);
    assert.ok(statsA.topAgents.some(function (t) { return t.agentId === rec.id; }),
      'custom agent appears in key A top-agents');
    assert.strictEqual(statsB.totalCalls, 0);
    assert.deepStrictEqual(statsB.topAgents, [], 'key B stats show nothing');
  },

  'isolation: dialer recents are per-key (setScope partitions localStorage)': function () {
    CallX.recents._store = mockStorage();
    CallX.recents.setScope(null);
    CallX.recents.setScope(KEY_A);
    CallX.recents.push({ name: 'Zed Iso', number: '+92 300 1234567', agentId: 'custom_x' });
    assert.strictEqual(CallX.recents.list().length, 1, 'visible under key A');
    CallX.recents.setScope(KEY_B);
    assert.deepStrictEqual(CallX.recents.list(), [], 'invisible under key B');
    CallX.recents.setScope(KEY_A);
    assert.strictEqual(CallX.recents.list()[0].number, '+92 300 1234567', 'back under key A');
    CallX.recents.setScope(null); // restore legacy default for other tests
  },

  'isolation: SymAgent directory section only lists the active key customs': async function () {
    var s = new customAgents.CustomAgentStore(tmpdir());
    await s.create(KEY_A, validCustom());
    var secA = customAgents.directorySection(s.list(KEY_A));
    var secB = customAgents.directorySection(s.list(KEY_B));
    assert.ok(secA.indexOf('Zed Iso') !== -1, 'A section names the agent');
    assert.strictEqual(secB, '', 'B section is empty (omitted from prompt)');
  },

  /* ---------- reactivity: store updates flow into the merged data source ---------- */

  'reactivity: update is visible in the merged directory/dialer list': async function () {
    var s = new customAgents.CustomAgentStore(tmpdir());
    var rec = await s.create(KEY_A, validCustom());
    await s.update(KEY_A, rec.id, Object.assign(validCustom(), { name: 'Zed Renamed', number: '+92 300 7654321' }));
    var merged = clientCustom.mergeAgentLists(BUILTIN, s.list(KEY_A));
    var row = merged.filter(function (a) { return a.id === rec.id; })[0];
    assert.ok(row, 'still present after edit');
    assert.strictEqual(row.name, 'Zed Renamed');
    assert.strictEqual(row.number, '+92 300 7654321', 'new number immediately dialable via merged list');
  },

  'reactivity: delete removes the agent from the merged list': async function () {
    var s = new customAgents.CustomAgentStore(tmpdir());
    var rec = await s.create(KEY_A, validCustom());
    assert.ok(clientCustom.mergeAgentLists(BUILTIN, s.list(KEY_A)).some(function (a) { return a.id === rec.id; }));
    await s.remove(KEY_A, rec.id);
    var merged = clientCustom.mergeAgentLists(BUILTIN, s.list(KEY_A));
    assert.ok(!merged.some(function (a) { return a.id === rec.id; }), 'gone after delete');
    assert.strictEqual(merged.length, BUILTIN.length);
  },

  'reactivity: event detail carries the action so subscribers can refresh': function () {
    // Contract: emitters call emitChanged({ action: 'created'|'updated'|'deleted', id })
    // and the subscriber (app.js) re-merges the directory for the active key.
    // The browser wiring (notifyChanged in custom-agents.js, the
    // window.addEventListener in app.js) is DOM-only and not run here.
    var ch = new customEvents.CustomAgentChannel();
    var actions = [];
    ch.subscribe(function (d) { actions.push(d.action + ':' + d.id); });
    ch.emit({ action: 'created', id: 'custom_1' });
    ch.emit({ action: 'updated', id: 'custom_1' });
    ch.emit({ action: 'deleted', id: 'custom_1' });
    assert.deepStrictEqual(actions, ['created:custom_1', 'updated:custom_1', 'deleted:custom_1']);
  },

  /* ---------- recents setScope behavior ---------- */

  'recents: setScope validates the hash, null restores the legacy key': function () {
    CallX.recents._store = mockStorage();
    assert.throws(function () { CallX.recents.setScope('nope'); }, /64 hex/);
    assert.throws(function () { CallX.recents.setScope('z'.repeat(64)); }, /64 hex/);
    CallX.recents.setScope(KEY_A);
    assert.strictEqual(CallX.recents.scope(), KEY_A);
    CallX.recents.setScope(null);
    assert.strictEqual(CallX.recents.scope(), null);
    CallX.recents.setScope('');
    assert.strictEqual(CallX.recents.scope(), null);
  },

  'recents: legacy unscoped entries migrate once into an empty scoped partition': function () {
    var st = mockStorage();
    CallX.recents._store = st;
    CallX.recents.setScope(null);
    CallX.recents.push({ name: 'Legacy', number: '555-0001' });
    assert.strictEqual(st.getItem('callx_recents_v1') !== null, true, 'legacy key written');
    CallX.recents.setScope(KEY_A);
    assert.strictEqual(CallX.recents.list().length, 1, 'migrated into key A partition');
    assert.strictEqual(CallX.recents.list()[0].name, 'Legacy');
    assert.strictEqual(st.getItem('callx_recents_v1'), null, 'legacy key cleared after migration');
    // second scope: no double-migration, no cross-key merge
    CallX.recents.push({ name: 'A-only', number: '555-0002' });
    CallX.recents.setScope(KEY_B);
    assert.deepStrictEqual(CallX.recents.list(), [], 'key B starts empty');
    CallX.recents.setScope(KEY_A);
    assert.strictEqual(CallX.recents.list().length, 2, 'key A keeps both entries');
    CallX.recents.setScope(null);
  },

  'recents: migration never overwrites a non-empty scoped partition': function () {
    var st = mockStorage();
    CallX.recents._store = st;
    CallX.recents.setScope(KEY_A);
    CallX.recents.push({ name: 'A-entry', number: '555-1' });
    CallX.recents.setScope(null);
    CallX.recents.push({ name: 'Legacy', number: '555-9' }); // legacy written while unscoped
    CallX.recents.setScope(KEY_A); // scoped partition non-empty -> no merge
    var names = CallX.recents.list().map(function (e) { return e.name; });
    assert.deepStrictEqual(names, ['A-entry'], 'legacy entries do not leak into a populated partition');
    CallX.recents.setScope(null);
  }
};
