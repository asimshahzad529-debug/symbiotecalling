'use strict';
/* tests/test-v8-ivr.test.js — v8 #13: IVR call menu.
 *
 * Pure logic tests: config validation, spoken menu prompt, digit
 * resolution, per-key store round-trip. No network, no API key.
 */
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var ivr = require('../src/ivr');

var KH1 = 'c'.repeat(64);
var KH2 = 'd'.repeat(64);

var GOOD = {
  menu: [
    { digit: '1', label: 'Sales', agentId: 'lina' },
    { digit: '2', label: 'Support', agentId: 'ava' }
  ],
  defaultAgentId: 'symagent'
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ivr-test-'));
}

module.exports = {
  'normalizeConfig: accepts a valid config': function () {
    var n = ivr.normalizeConfig(GOOD);
    assert.strictEqual(n.menu.length, 2);
    assert.strictEqual(n.menu[0].digit, '1');
    assert.strictEqual(n.defaultAgentId, 'symagent');
  },

  'normalizeConfig: label defaults to agentId when empty': function () {
    var n = ivr.normalizeConfig({ menu: [{ digit: '1', agentId: 'lina' }], defaultAgentId: 'symagent' });
    assert.strictEqual(n.menu[0].label, 'lina');
  },

  'normalizeConfig: rejects garbage': function () {
    assert.throws(function () { ivr.normalizeConfig(null); });
    assert.throws(function () { ivr.normalizeConfig({ menu: [], defaultAgentId: 'symagent' }); });
    assert.throws(function () { ivr.normalizeConfig({ menu: [{ digit: '12', label: 'x', agentId: 'lina' }], defaultAgentId: 'symagent' }); });
    assert.throws(function () {
      ivr.normalizeConfig({ menu: [{ digit: '1', agentId: 'lina' }, { digit: '1', agentId: 'ava' }], defaultAgentId: 'symagent' });
    }, /duplicate/);
    assert.throws(function () { ivr.normalizeConfig({ menu: [{ digit: '1', agentId: 'lina' }] }); }, /defaultAgentId/);
    assert.throws(function () { ivr.normalizeConfig({ menu: [{ digit: '1' }], defaultAgentId: 'symagent' }); }, /agentId/);
  },

  'normalizeConfig: unknown agent ids rejected when lookup given': function () {
    var exists = function (id) { return id !== 'ghost'; };
    assert.throws(function () {
      ivr.normalizeConfig({ menu: [{ digit: '1', agentId: 'ghost' }], defaultAgentId: 'symagent' }, exists);
    }, /unknown/);
    assert.doesNotThrow(function () { ivr.normalizeConfig(GOOD, function () { return true; }); });
  },

  'buildMenuPrompt: spoken bilingual text': function () {
    var p = ivr.buildMenuPrompt(ivr.normalizeConfig(GOOD));
    assert.ok(p.indexOf('1') !== -1 && p.indexOf('2') !== -1, p);
    assert.ok(/sales ke liye 1 dabayein/i.test(p), p);
    assert.ok(/support ke liye 2 dabayein/i.test(p), p);
  },

  'buildMenuPrompt: empty menu falls back': function () {
    assert.ok(ivr.buildMenuPrompt({ menu: [] }).length > 0);
    assert.ok(ivr.buildMenuPrompt(null).length > 0);
  },

  'resolveDigit: hits and misses': function () {
    var cfg = ivr.normalizeConfig(GOOD);
    assert.strictEqual(ivr.resolveDigit(cfg, '1'), 'lina');
    assert.strictEqual(ivr.resolveDigit(cfg, '2'), 'ava');
    assert.strictEqual(ivr.resolveDigit(cfg, '3'), null);
    assert.strictEqual(ivr.resolveDigit(cfg, ''), null);
    assert.strictEqual(ivr.resolveDigit(cfg, null), null);
    assert.strictEqual(ivr.resolveDigit(null, '1'), null);
  },

  'IvrStore: save + get round-trip': function () {
    var dir = tmpDir();
    var store = new ivr.IvrStore(dir, KH1);
    assert.strictEqual(store.get(), null);
    var saved = store.save(GOOD);
    assert.strictEqual(saved.defaultAgentId, 'symagent');
    var got = store.get();
    assert.deepStrictEqual(got, saved);
    fs.rmSync(dir, { recursive: true });
  },

  'IvrStore: per-key isolation': function () {
    var dir = tmpDir();
    new ivr.IvrStore(dir, KH1).save(GOOD);
    assert.strictEqual(new ivr.IvrStore(dir, KH2).get(), null);
    fs.rmSync(dir, { recursive: true });
  },

  'IvrStore: file name is per-key': function () {
    assert.strictEqual(ivr.IvrStore.fileNameFor(KH1), 'ivr_' + KH1 + '.json');
  },

  'IvrStore: save rejects bad config': function () {
    var dir = tmpDir();
    var store = new ivr.IvrStore(dir, KH1);
    assert.throws(function () { store.save({ menu: [] }); });
    fs.rmSync(dir, { recursive: true });
  },

  'MENU_TIMEOUT_MS is a sane positive value': function () {
    assert.ok(ivr.MENU_TIMEOUT_MS > 0 && ivr.MENU_TIMEOUT_MS <= 120000);
  }
};
