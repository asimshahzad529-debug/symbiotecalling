'use strict';
/* tests/avatar.test.js — procedural avatars: unique, deterministic, valid. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var agents = require('../src/agents');

function loadAvatar() {
  var sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'avatar.js'), 'utf8'), sandbox);
  return vm.runInContext('avatarSVG', sandbox);
}

module.exports = {
  '101 unique deterministic well-formed avatars': function () {
    var avatarSVG = loadAvatar();
    var seen = new Set();
    agents.AGENTS.forEach(function (a) {
      var s1 = avatarSVG(a), s2 = avatarSVG(a);
      assert.strictEqual(s1, s2, 'deterministic for ' + a.id);
      assert.ok(!seen.has(s1), 'unique for ' + a.id);
      seen.add(s1);
      assert.ok(s1.indexOf('<svg') === 0 && s1.indexOf('</svg>') !== -1, 'well-formed for ' + a.id);
    });
    assert.strictEqual(seen.size, 101);
  },
  'avatar honors agent color and id': function () {
    var avatarSVG = loadAvatar();
    var s = avatarSVG({ id: 'hugo', color: '#f59e0b' });
    assert.ok(s.indexOf('#f59e0b') !== -1, 'uses agent color');
    var s2 = avatarSVG({ id: 'hugo2', color: '#f59e0b' });
    assert.notStrictEqual(s, s2, 'different id -> different avatar');
  },
  'every agent has its AI portrait photo on disk': function () {
    var dir = path.join(__dirname, '..', 'public', 'avatars');
    var missing = [];
    agents.AGENTS.forEach(function (a) {
      var f = path.join(dir, a.id + '.jpg');
      if (!fs.existsSync(f) || fs.statSync(f).size < 5000) missing.push(a.id);
    });
    assert.strictEqual(missing.length, 0, 'missing avatars: ' + missing.join(','));
  }
};
