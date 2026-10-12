'use strict';
/* tests/test-v7-ws4-directory.test.js — v7 WS4 "Directory UX" (public/directory.js).
 * Covers the pure logic: filterAgents, extractSwipeAction, computeStatsFromHistory.
 * DOM functions (renderDirectory, profileSheet, attachSwipe wiring) are browser-only
 * and are not exercised here — no DOM exists in node.
 */
var assert = require('assert');
var Directory = require('../public/directory');

var AGENTS = [
  { id: 'ava', name: 'Ava', number: '+1 (555) 010-0001', role: 'Sales Master', niche: 'Real Estate Sales', gender: 'female', voice: 'Kore', tone: 'professional' },
  { id: 'marco', name: 'Marco', number: '+1 (555) 010-0002', role: 'Sales Rep', niche: 'Car Dealership', gender: 'male', voice: 'Fenrir', tone: 'friendly' },
  { id: 'lina', name: 'Lina', number: '+1 (555) 010-0003', role: 'Concierge', niche: 'Travel Concierge', gender: 'female', voice: 'Leda', tone: 'warm' },
  { id: 'harper', name: 'Harper', number: '+1 (555) 010-0004', role: 'Support Agent', niche: 'Tech Support', gender: 'female', voice: 'Kore', tone: 'patient' },
  { id: 'nova', name: 'Nova', number: '+1 (555) 010-0005', role: 'Receptionist', niche: 'Clinic Reception', gender: 'female', voice: 'Zephyr', tone: 'calm', isCustom: true }
];

module.exports = {
  'filterAgents matches name case-insensitively': function () {
    var r = Directory.filterAgents(AGENTS, { q: 'aVA' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'ava');
  },
  'filterAgents matches number substring': function () {
    var r = Directory.filterAgents(AGENTS, { q: '010-0002' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'marco');
  },
  'filterAgents matches niche substring': function () {
    var r = Directory.filterAgents(AGENTS, { q: 'travel' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'lina');
  },
  'filterAgents matches role substring': function () {
    var r = Directory.filterAgents(AGENTS, { q: 'sales' });
    assert.strictEqual(r.length, 2);
    var ids = r.map(function (a) { return a.id; }).sort();
    assert.deepStrictEqual(ids, ['ava', 'marco']);
  },
  'filterAgents gender filter': function () {
    var male = Directory.filterAgents(AGENTS, { q: '', gender: 'male' });
    assert.strictEqual(male.length, 1);
    assert.strictEqual(male[0].id, 'marco');
    var female = Directory.filterAgents(AGENTS, { q: '', gender: 'female' });
    assert.strictEqual(female.length, 4);
    var any = Directory.filterAgents(AGENTS, { q: '', gender: 'any' });
    assert.strictEqual(any.length, 5);
  },
  'filterAgents role filter is free-text substring': function () {
    var r = Directory.filterAgents(AGENTS, { q: '', role: 'concierge' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'lina');
    var anyRole = Directory.filterAgents(AGENTS, { q: '', role: 'any' });
    assert.strictEqual(anyRole.length, 5);
  },
  'filterAgents combined q + gender + role': function () {
    var r = Directory.filterAgents(AGENTS, { q: 'a', gender: 'female', role: 'agent' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'harper');
  },
  'filterAgents empty query returns all': function () {
    assert.strictEqual(Directory.filterAgents(AGENTS, {}).length, 5);
    assert.strictEqual(Directory.filterAgents(AGENTS, { q: '  ' }).length, 5);
  },
  'filterAgents no match returns empty array': function () {
    assert.deepStrictEqual(Directory.filterAgents(AGENTS, { q: 'zzzz-nope' }), []);
  },
  'filterAgents tolerates non-array input': function () {
    assert.deepStrictEqual(Directory.filterAgents(null, { q: 'a' }), []);
  },
  'filterAgents keeps custom agents when matched': function () {
    var r = Directory.filterAgents(AGENTS, { q: 'nova' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].isCustom, true);
  },

  'extractSwipeAction right swipe over threshold': function () {
    assert.strictEqual(Directory.extractSwipeAction(90, 10), 'right');
  },
  'extractSwipeAction left swipe over threshold': function () {
    assert.strictEqual(Directory.extractSwipeAction(-120, 5), 'left');
  },
  'extractSwipeAction ignores short drags': function () {
    assert.strictEqual(Directory.extractSwipeAction(59, 0), null);
    assert.strictEqual(Directory.extractSwipeAction(-30, 0), null);
  },
  'extractSwipeAction ignores mostly-vertical drags': function () {
    assert.strictEqual(Directory.extractSwipeAction(80, 120), null);
    assert.strictEqual(Directory.extractSwipeAction(10, 200), null);
  },
  'extractSwipeAction boundary and garbage inputs': function () {
    assert.strictEqual(Directory.extractSwipeAction(60, 0), 'right');
    assert.strictEqual(Directory.extractSwipeAction(NaN, NaN), null);
  },

  'computeStatsFromHistory aggregates one agent': function () {
    var calls = [
      { agentId: 'ava', durationSec: 90, outcome: 'booked' },
      { agentId: 'marco', durationSec: 30, outcome: 'no-answer' },
      { agentId: 'ava', durationSec: 150, outcome: 'callback' }
    ];
    var s = Directory.computeStatsFromHistory(calls, 'ava');
    assert.strictEqual(s.calls, 2);
    assert.strictEqual(s.minutes, 4); // 240s -> 4 min
    assert.strictEqual(s.lastOutcome, 'callback');
  },
  'computeStatsFromHistory ignores other agents and empty list': function () {
    var s = Directory.computeStatsFromHistory([{ agentId: 'x', durationSec: 60 }], 'ava');
    assert.deepStrictEqual(s, { calls: 0, minutes: 0, lastOutcome: '—' });
    var s2 = Directory.computeStatsFromHistory([], 'ava');
    assert.deepStrictEqual(s2, { calls: 0, minutes: 0, lastOutcome: '—' });
  },

  'Directory exposes the full contract surface': function () {
    ['filterAgents', 'extractSwipeAction', 'computeStatsFromHistory', 'attachSwipe',
     'profileSheet', 'closeSheet', 'renderDirectory'].forEach(function (k) {
      assert.strictEqual(typeof Directory[k], 'function', k + ' should be a function');
    });
  }
};
