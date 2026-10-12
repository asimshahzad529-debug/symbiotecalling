'use strict';
/* tests/test-v7-ws2-custom.test.js — WS2 custom agent builder (v7). */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var customAgents = require('../src/customAgents');
var apiv7custom = require('../src/apiv7_custom');
var agents = require('../src/agents');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-test-'));
}
function freshStore() { return new customAgents.CustomAgentStore(tmpDir()); }
var KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64);
var TINY_IMG = 'data:image/jpeg;base64,' + Buffer.from('fakejpegbytes').toString('base64');

function valid() {
  return { name: 'Test Agent', number: '0312 5550000', role: 'Test Concierge', tone: 'friendly', voice: 'Charon', prompt: 'Be helpful.' };
}

module.exports = {
  // ---------- validation ----------
  'validate: missing name -> error': function () {
    var v = customAgents.validate({ number: '123', role: 'r' });
    assert.ok(!v.ok && /name/i.test(v.error));
  },
  'validate: missing number -> error': function () {
    var v = customAgents.validate({ name: 'n', role: 'r' });
    assert.ok(!v.ok && /number/i.test(v.error));
  },
  'validate: missing role -> error': function () {
    var v = customAgents.validate({ name: 'n', number: '123' });
    assert.ok(!v.ok && /role/i.test(v.error));
  },
  'validate: bad tone rejected': function () {
    var v = customAgents.validate(Object.assign(valid(), { tone: 'robotic' }));
    assert.ok(!v.ok && /tone/i.test(v.error));
  },
  'validate: tone defaults to professional': function () {
    var d = valid(); delete d.tone;
    var v = customAgents.validate(d);
    assert.ok(v.ok && v.value.tone === 'professional');
  },
  'validate: oversize prompt rejected': function () {
    var v = customAgents.validate(Object.assign(valid(), { prompt: 'x'.repeat(4001) }));
    assert.ok(!v.ok && /prompt/i.test(v.error));
  },
  'validate: avatar input is ignored (v7.5 removal)': function () {
    var big = 'data:image/jpeg;base64,' + 'A'.repeat(600 * 1024);
    var v = customAgents.validate(Object.assign(valid(), { avatar: { kind: 'upload', dataUrl: big } }));
    assert.ok(v.ok, 'avatar input must not fail validation, got: ' + v.error);
    assert.strictEqual(v.value.avatar, undefined, 'avatar is stripped from the cleaned record');
  },
  'validate: unknown voice rejected': function () {
    var v = customAgents.validate(Object.assign(valid(), { voice: 'NotAVoice' }));
    assert.ok(!v.ok && /voice/i.test(v.error));
  },
  'validate: known voice accepted': function () {
    var v = customAgents.validate(valid());
    assert.ok(v.ok && v.value.voice === 'Charon');
  },
  'validate: voice omitted picks a known default': function () {
    var d = valid(); delete d.voice;
    var v = customAgents.validate(d);
    assert.ok(v.ok && customAgents.listVoices().indexOf(v.value.voice) >= 0);
  },
  'listVoices: deduped voices from built-ins': function () {
    var voices = customAgents.listVoices();
    assert.ok(Array.isArray(voices) && voices.length >= 5);
    assert.ok(voices.indexOf('Charon') >= 0);
    assert.deepStrictEqual(voices, voices.slice().sort());
    assert.strictEqual(new Set(voices).size, voices.length);
  },

  // ---------- CRUD + isolation ----------
  'CRUD round-trip': async function () {
    var s = freshStore();
    assert.deepStrictEqual(s.list(KEY_A), []);
    var c = await s.create(KEY_A, valid());
    assert.ok(/^custom_[0-9a-f]{8}$/.test(c.id), 'id shape custom_<8hex>, got ' + c.id);
    assert.strictEqual(c.isCustom, true);
    assert.strictEqual(s.list(KEY_A).length, 1);
    assert.strictEqual(s.get(KEY_A, c.id).name, 'Test Agent');
    var u = await s.update(KEY_A, c.id, Object.assign(valid(), { name: 'Renamed' }));
    assert.strictEqual(u.name, 'Renamed');
    assert.strictEqual(u.id, c.id, 'id stable across update');
    await s.remove(KEY_A, c.id);
    assert.deepStrictEqual(s.list(KEY_A), []);
  },
  'per-key isolation: two hashes separate': async function () {
    var s = freshStore();
    var a = await s.create(KEY_A, valid());
    assert.deepStrictEqual(s.list(KEY_B), [], 'other key sees nothing');
    assert.strictEqual(s.get(KEY_B, a.id), null);
    await assert.rejects(s.update(KEY_B, a.id, valid()), /not found/i);
  },
  'invalid keyHash rejected': async function () {
    var s = freshStore();
    assert.throws(function () { s.list('nope'); }, /invalid keyHash/i);
    await assert.rejects(s.create('nope', valid()), /invalid keyHash/i);
  },
  'create with validation error rejects': async function () {
    var s = freshStore();
    await assert.rejects(s.create(KEY_A, { number: '1', role: 'r' }), /name/i);
  },

  // ---------- clone / toAgent / findTarget / directory ----------
  'cloneFrom pre-fills from a built-in (not saved)': async function () {
    var s = freshStore();
    var built = agents.getById('lina'); // Elena, Travel Concierge
    var draft = customAgents.cloneFrom(KEY_A, built);
    assert.strictEqual(draft.name, built.name);
    assert.strictEqual(draft.number, built.number);
    assert.strictEqual(draft.role, built.niche);
    assert.strictEqual(draft.voice, built.voice);
    assert.strictEqual(draft.prompt, built.prompt);
    assert.deepStrictEqual(s.list(KEY_A), [], 'clone does not save');
  },
  'cloneFrom rejects a custom agent (clone protection)': async function () {
    var s = freshStore();
    var c = await s.create(KEY_A, valid());
    assert.throws(function () { customAgents.cloneFrom(KEY_A, c); }, /cannot be cloned/i);
    assert.deepStrictEqual(s.list(KEY_A).length, 1, 'no draft saved');
  },
  'cloneFrom rejects a toAgent-shaped custom object': async function () {
    var s = freshStore();
    var c = await s.create(KEY_A, valid());
    var shaped = customAgents.toAgent(c);
    assert.strictEqual(shaped.isCustom, true);
    assert.throws(function () { customAgents.cloneFrom(KEY_A, shaped); }, /cannot be cloned/i);
  },
  'toAgent shape matches built-in agent fields': async function () {
    var s = freshStore();
    var c = await s.create(KEY_A, valid());
    var a = customAgents.toAgent(c);
    ['id', 'name', 'number', 'voice', 'prompt', 'niche', 'tagline', 'color'].forEach(function (f) {
      assert.ok(a[f] !== undefined && a[f] !== null && a[f] !== '', 'field present: ' + f);
    });
    assert.strictEqual(a.isCustom, true);
    assert.strictEqual(a.niche, 'Test Concierge');
    assert.ok(a.prompt.indexOf('Test Agent') >= 0, 'prompt names the agent');
    assert.ok(a.prompt.indexOf('Be warm and friendly') >= 0, 'tone line present');
    assert.strictEqual(a.avatarUrl, null, 'no avatar -> null url');
    assert.strictEqual(a.hasAvatarUpload, false);
  },
  'toAgent ignores legacy avatar field — default avatar always': function () {
    // A record written before v7.5 may still carry avatar:{kind:'upload'};
    // reads stay harmless: no upload, no avatar URL, default avatar.
    var a = customAgents.toAgent(Object.assign({ id: 'custom_abcdef12' }, valid(), { avatar: { kind: 'upload' } }));
    assert.strictEqual(a.hasAvatarUpload, false);
    assert.strictEqual(a.avatarUrl, null);
  },
  'findTarget by id and by number': async function () {
    var s = freshStore();
    var c = await s.create(KEY_A, Object.assign(valid(), { number: '+92 312 5550000' }));
    var byId = customAgents.findTarget(s, KEY_A, c.id);
    assert.ok(byId && byId.id === c.id);
    var byNum = customAgents.findTarget(s, KEY_A, '+92 312 5550000');
    assert.ok(byNum && byNum.id === c.id, 'number match (kept as typed)');
    assert.strictEqual(customAgents.findTarget(s, KEY_A, 'custom_ffffffff'), null);
    assert.strictEqual(customAgents.findTarget(s, KEY_A, ''), null);
  },
  'directorySection contains name, number and role': async function () {
    var s = freshStore();
    var c = await s.create(KEY_A, valid());
    var sec = customAgents.directorySection(s.list(KEY_A));
    assert.ok(sec.indexOf('Test Agent') >= 0);
    assert.ok(sec.indexOf('0312 5550000') >= 0);
    assert.ok(sec.indexOf('Test Concierge') >= 0);
    assert.ok(sec.indexOf('CUSTOM AGENTS') >= 0);
    assert.strictEqual(customAgents.directorySection([]), '');
  },

  // ---------- API mount ----------
  'API: missing keyHash -> 400': async function () {
    var calls = [];
    var h = apiv7custom.mount(null, {
      sendJson: function (res, code, obj) { calls.push([code, obj]); return true; },
      readBody: async function () { return '{}'; },
      dataDir: tmpDir(),
      agents: agents,
      customAgents: customAgents
    });
    var handled = await h({ method: 'GET', url: '/api/v7/custom-agents', headers: {} }, {});
    assert.ok(handled);
    assert.strictEqual(calls[0][0], 400);
    assert.ok(/key/i.test(calls[0][1].error));
  },
  'API: ignores unrelated paths': async function () {
    var h = apiv7custom.mount(null, {
      sendJson: function () { return true; },
      readBody: async function () { return '{}'; },
      dataDir: tmpDir(),
      agents: agents,
      customAgents: customAgents
    });
    assert.strictEqual(await h({ method: 'GET', url: '/api/agents', headers: {} }, {}), false);
  },
  'API: full CRUD via mount — avatar input ignored, no avatar files': async function () {
    var dir = tmpDir();
    var reqQ = [];
    var h = apiv7custom.mount(null, {
      sendJson: function (res, code, obj) { res._code = code; res._obj = obj; return true; },
      readBody: async function () { return reqQ.shift() || '{}'; },
      dataDir: dir,
      agents: agents,
      customAgents: customAgents
    });
    function req(method, u, body) {
      // Only queue a body for methods that read one; GET routes never call
      // readBody, so a queued '{}' would leak into the next POST/PUT.
      if ((method === 'POST' || method === 'PUT') && body) reqQ.push(JSON.stringify(body));
      var r = { method: method, url: u, headers: { 'x-key-hash': KEY_A } };
      var res = {};
      return h(r, res).then(function () { return res; });
    }
    var l0 = await req('GET', '/api/v7/custom-agents');
    assert.deepStrictEqual(l0._obj.agents, []);
    var post = await req('POST', '/api/v7/custom-agents', Object.assign(valid(), { avatar: { kind: 'upload', dataUrl: TINY_IMG } }));
    assert.strictEqual(post._code, 201);
    var id = post._obj.agent.id;
    assert.ok(/^custom_[0-9a-f]{8}$/.test(id));
    assert.strictEqual(post._obj.agent.hasAvatarUpload, false, 'no avatar uploads in v7.5');
    assert.strictEqual(post._obj.agent.avatarUrl, null);
    assert.ok(!fs.existsSync(path.join(dir, 'avatars_custom')), 'no avatar storage dir created');
    var l1 = await req('GET', '/api/v7/custom-agents');
    assert.strictEqual(l1._obj.agents.length, 1);
    var put = await req('PUT', '/api/v7/custom-agents/' + id, Object.assign(valid(), { name: 'Edited' }));
    assert.strictEqual(put._obj.agent.name, 'Edited');
    assert.strictEqual(put._obj.agent.hasAvatarUpload, false);
    var avHandled = await h({ method: 'GET', url: '/api/v7/custom-agents/' + id + '/avatar', headers: { 'x-key-hash': KEY_A } }, {});
    assert.strictEqual(avHandled, false, 'avatar route removed (falls through unhandled)');
    var clone = await req('POST', '/api/v7/custom-agents/clone', { sourceId: 'lina' });
    assert.strictEqual(clone._obj.draft.name, 'Elena');
    var clone2 = await req('POST', '/api/v7/custom-agents/clone', { sourceId: id });
    assert.strictEqual(clone2._code, 403, 'custom agent clone rejected');
    assert.ok(/cannot be cloned/i.test(clone2._obj.error));
    var del = await req('DELETE', '/api/v7/custom-agents/' + id);
    assert.deepStrictEqual(del._obj, { ok: true });
    var notfound = await req('GET', '/api/v7/custom-agents/' + id);
    assert.strictEqual(notfound._code, 404);
  },
  'API: POST validation error -> 400, bad clone -> 404': async function () {
    var dir = tmpDir();
    var reqQ = [];
    var h = apiv7custom.mount(null, {
      sendJson: function (res, code, obj) { res._code = code; res._obj = obj; return true; },
      readBody: async function () { return reqQ.shift() || '{}'; },
      dataDir: dir,
      agents: agents,
      customAgents: customAgents
    });
    function req2(method, u, body) {
      // Only queue a body for methods that read one; GET routes never call
      // readBody, so a queued '{}' would leak into the next POST/PUT.
      if ((method === 'POST' || method === 'PUT') && body) reqQ.push(JSON.stringify(body));
      var r = { method: method, url: u, headers: { 'x-key-hash': KEY_A } };
      var res = {};
      return h(r, res).then(function () { return res; });
    }
    var bad = await req2('POST', '/api/v7/custom-agents', { name: 'x' });
    assert.strictEqual(bad._code, 400);
    assert.ok(/number/i.test(bad._obj.error));
    var clone = await req2('POST', '/api/v7/custom-agents/clone', { sourceId: 'nope' });
    assert.strictEqual(clone._code, 404);
    var qk = await h({ method: 'GET', url: '/api/v7/custom-agents?keyHash=' + KEY_A, headers: {} }, {});
    assert.ok(qk !== false, 'query keyHash accepted');
  },
  'API: clone of a custom agent id -> 403 (clone protection)': async function () {
    var dir = tmpDir();
    var reqQ = [];
    var h = apiv7custom.mount(null, {
      sendJson: function (res, code, obj) { res._code = code; res._obj = obj; return true; },
      readBody: async function () { return reqQ.shift() || '{}'; },
      dataDir: dir,
      agents: agents,
      customAgents: customAgents
    });
    function req3(method, u, body) {
      if ((method === 'POST' || method === 'PUT') && body) reqQ.push(JSON.stringify(body));
      var r = { method: method, url: u, headers: { 'x-key-hash': KEY_A } };
      var res = {};
      return h(r, res).then(function () { return res; });
    }
    // Built-in clone still works.
    var okBuilt = await req3('POST', '/api/v7/custom-agents/clone', { sourceId: 'lina' });
    assert.strictEqual(okBuilt._code, 200);
    assert.strictEqual(okBuilt._obj.draft.name, 'Elena');
    // Custom-agent ids are rejected even though they exist in the store.
    var s = new customAgents.CustomAgentStore(dir);
    var c = await s.create(KEY_A, valid());
    assert.ok(c.id.indexOf('custom_') === 0);
    var denied = await req3('POST', '/api/v7/custom-agents/clone', { sourceId: c.id });
    assert.strictEqual(denied._code, 403);
    assert.ok(/cannot be cloned/i.test(denied._obj.error));
  }
};
