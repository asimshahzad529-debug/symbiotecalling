'use strict';
/* tests/agents.test.js — the 50-agent directory is valid and dialable. */
var assert = require('assert');
var agents = require('../src/agents');
var prompt = require('../src/prompt');

var FEMININE_VOICES = ['Kore', 'Zephyr', 'Puck', 'Aoede', 'Leda'];
var MASCULINE_VOICES = ['Charon', 'Fenrir', 'Orus', 'Enceladus'];

module.exports = {
  'exactly 101 agents (100 niche + SymAgent)': function () {
    assert.strictEqual(agents.AGENTS.length, 101);
    assert.strictEqual(agents.list().length, 101);
  },
  'ids, numbers unique; numbers fictional 555 range; gender set': function () {
    var ids = new Set(), nums = new Set();
    agents.AGENTS.forEach(function (a) {
      assert.ok(a.id && a.name && a.niche && a.number && a.voice && a.prompt && a.gender, 'agent ' + a.id + ' complete');
      assert.ok(a.gender === 'female' || a.gender === 'male', 'gender for ' + a.id);
      assert.ok(!ids.has(a.id), 'dup id ' + a.id); ids.add(a.id);
      var d = agents.digitsOf(a.number);
      assert.ok(!nums.has(d), 'dup number ' + a.number); nums.add(d);
      assert.ok(d.startsWith('1555010'), 'fictional 555 range: ' + a.number);
    });
  },
  'voice matches gender (feminine voices for female agents, masculine for male)': function () {
    agents.AGENTS.forEach(function (a) {
      if (a.gender === 'female') assert.ok(FEMININE_VOICES.indexOf(a.voice) !== -1, a.id + ' should have a feminine voice, got ' + a.voice);
      else assert.ok(MASCULINE_VOICES.indexOf(a.voice) !== -1, a.id + ' should have a masculine voice, got ' + a.voice);
    });
  },
  'system instruction tells the model to act the gender': function () {
    var f = prompt.buildAgentInstruction(agents.getById('lina'));
    assert.ok(/speak as a woman/i.test(f), 'female voice-identity line');
    var m = prompt.buildAgentInstruction(agents.getById('marco'));
    assert.ok(/speak as a man/i.test(m), 'male voice-identity line');
    assert.ok(f.indexOf('Elena') !== -1 && m.indexOf('Roman') !== -1);
  },
  'all-english unique names; sales master present; no urdu names': function () {
    var urdu = ['iman', 'kabeer', 'laila', 'rehan', 'mahnoor', 'hamza', 'zoya', 'arsalan', 'jawad', 'hira', 'nabeel', 'usman', 'sadia', 'ali', 'gul', 'fahad', 'kinza', 'razia', 'mehak', 'imran'];
    urdu.forEach(function (id) { assert.strictEqual(agents.getById(id), null, 'urdu name removed: ' + id); });
    var hugo = agents.getById('hugo');
    assert.ok(hugo, 'sales master exists');
    assert.strictEqual(hugo.name, 'Liam', 'sales master renamed per user list');
    assert.ok(/sales/i.test(hugo.niche), 'hugo is the sales agent');
    assert.ok(/roleplay|objection/i.test(hugo.prompt), 'sales practice prompt');
    var names = agents.AGENTS.map(function (a) { return a.name.toLowerCase(); });
    assert.strictEqual(new Set(names).size, 101, 'all names unique');
  },
  'numbers span 0001-0101 in the fictional range': function () {
    var nums = agents.AGENTS.map(function (a) { return agents.digitsOf(a.number); }).sort();
    assert.strictEqual(nums[0], '15550100001');
    assert.strictEqual(nums[99], '15550100100');
    assert.strictEqual(nums[100], '15550100101');
  },
  'getById resolves; unknown id null': function () {
    assert.strictEqual(agents.getById('ava').name, 'Jacob');
    assert.strictEqual(agents.getById('max').name, 'Aurora');
    assert.strictEqual(agents.getById('hugo').name, 'Liam');
    assert.strictEqual(agents.getById('nope'), null);
  },
  'getByNumber dials with varied formatting': function () {
    assert.strictEqual(agents.getByNumber('+1 (555) 010-0001').id, 'ava');
    assert.strictEqual(agents.getByNumber('15550100002').id, 'marco');
    assert.strictEqual(agents.getByNumber('(555) 010-0003').id, 'lina');
    assert.strictEqual(agents.getByNumber('5550100070').id, 'rocco');
    assert.strictEqual(agents.getByNumber('5550100100').id, 'max');
    assert.strictEqual(agents.getByNumber('+1 (555) 999-9999'), null);
    assert.strictEqual(agents.getByNumber(''), null);
  },
  'safety limits baked into sensitive prompts': function () {
    assert.ok(/NEVER diagnose/i.test(agents.getById('harper').prompt));
    assert.ok(/NOT a lawyer/i.test(agents.getById('omar').prompt));
    assert.ok(/NOT a therapist/i.test(agents.getById('tara').prompt));
    assert.ok(/NEVER ask for account numbers/i.test(agents.getById('sofia').prompt));
    assert.ok(/not a financial advisor/i.test(agents.getById('neil').prompt));
    assert.ok(/NOT a pharmacist/i.test(agents.getById('elias').prompt));
    assert.ok(/NOT a veterinarian/i.test(agents.getById('freya').prompt));
  },
  'list() exposes no prompt text': function () {
    agents.list().forEach(function (a) {
      assert.ok(!('prompt' in a), 'prompt must not leak to the client');
      assert.ok(!('knowledge' in a), 'knowledge must not leak to the client');
    });
  }
};
