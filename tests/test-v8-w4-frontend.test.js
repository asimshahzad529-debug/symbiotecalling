'use strict';
/* tests/test-v8-w4-frontend.test.js — v8.0.0 W4 (Agents view + Dashboard).
 * Covers pure logic in public/directory.js (#39 pins, #40 greeting/suggest),
 * public/analytics.js (#4-frontend normalize/busyHours/fmtDur) and
 * public/timeline.js (#42 filterCalls/groupByDay/agentOptions).
 */
var assert = require('assert');
var Directory = require('../public/directory');
var analyticsMod = require('../public/analytics');
var timelineMod = require('../public/timeline');

var DashAnalytics = analyticsMod.DashAnalytics;
var CallTimeline = timelineMod.CallTimeline;

var AGENTS = [
  { id: 'ava', name: 'Ava', number: '+1 (555) 010-0001', niche: 'Real Estate Sales' },
  { id: 'marco', name: 'Marco', number: '+1 (555) 010-0002', niche: 'Car Dealership' },
  { id: 'symagent', name: 'SymAgent', number: '+1 (555) 010-0101', niche: 'Company Rep' }
];

module.exports = {
  // #40 greeting
  'greetingForHour: morning/afternoon/evening boundaries': function () {
    assert.strictEqual(Directory.greetingForHour(0), 'Good morning');
    assert.strictEqual(Directory.greetingForHour(11), 'Good morning');
    assert.strictEqual(Directory.greetingForHour(12), 'Good afternoon');
    assert.strictEqual(Directory.greetingForHour(16), 'Good afternoon');
    assert.strictEqual(Directory.greetingForHour(17), 'Good evening');
    assert.strictEqual(Directory.greetingForHour(23), 'Good evening');
    assert.strictEqual(Directory.greetingForHour('bad'), 'Good evening');
  },
  // #39 pins
  'pinsStorageKey is per-key partitioned': function () {
    var a = Directory.pinsStorageKey('abc123');
    var b = Directory.pinsStorageKey('def456');
    assert.ok(a.indexOf('abc123') !== -1);
    assert.ok(b.indexOf('def456') !== -1);
    assert.notStrictEqual(a, b);
    assert.ok(Directory.pinsStorageKey(null).indexOf('shared') !== -1);
  },
  'normalizePinList dedups and drops junk': function () {
    assert.deepStrictEqual(Directory.normalizePinList(['a', 'b', 'a', '', null, 5]), ['a', 'b', '5']);
    assert.deepStrictEqual(Directory.normalizePinList('nope'), []);
  },
  'toggleInList pins then unpins without mutating input': function () {
    var start = ['ava'];
    var r1 = Directory.toggleInList(start, 'marco');
    assert.deepStrictEqual(r1.list, ['ava', 'marco']);
    assert.strictEqual(r1.pinned, true);
    assert.deepStrictEqual(start, ['ava']);
    var r2 = Directory.toggleInList(r1.list, 'ava');
    assert.deepStrictEqual(r2.list, ['marco']);
    assert.strictEqual(r2.pinned, false);
  },
  'agentKey falls back to number/name': function () {
    assert.strictEqual(Directory.agentKey({ id: 'x' }), 'x');
    assert.strictEqual(Directory.agentKey({ number: '555' }), '555');
    assert.strictEqual(Directory.agentKey({ name: 'N' }), 'N');
    assert.strictEqual(Directory.agentKey(null), '');
  },
  // #40 suggestions
  'suggestAgents ranks recency-weighted recents first': function () {
    var recents = [{ agentId: 'marco' }, { agentId: 'ava' }, { agentId: 'marco' }];
    var sug = Directory.suggestAgents(recents, AGENTS, [], 3);
    assert.strictEqual(sug[0].id, 'marco');
    assert.strictEqual(sug[1].id, 'ava');
  },
  'suggestAgents folds in /api/stats topAgents and skips unknown ids': function () {
    var sug = Directory.suggestAgents([], AGENTS, [{ agentId: 'ava' }, { agentId: 'ghost' }], 3);
    assert.strictEqual(sug.length, 1);
    assert.strictEqual(sug[0].id, 'ava');
  },
  'suggestAgents returns empty when nothing matches': function () {
    assert.deepStrictEqual(Directory.suggestAgents([], AGENTS, [], 3), []);
  },
  // #4 analytics
  'normalizeAnalytics pads byHour to 24 and sorts by calls': function () {
    var d = DashAnalytics.normalizeAnalytics({
      agents: [
        { agentId: 'b', name: 'B', calls: 2, avgSecs: 90, byHour: [1, 1] },
        { agentId: 'a', name: 'A', calls: 5, avgSecs: 61.7, byHour: [5] }
      ],
      totals: { calls: 7, minutes: 12 }
    });
    assert.strictEqual(d.agents[0].agentId, 'a');
    assert.strictEqual(d.agents[0].byHour.length, 24);
    assert.strictEqual(d.agents[1].byHour[2], 0);
    assert.deepStrictEqual(d.totals, { calls: 7, minutes: 12 });
  },
  'normalizeAnalytics returns null on junk': function () {
    assert.strictEqual(DashAnalytics.normalizeAnalytics(null), null);
    assert.strictEqual(DashAnalytics.normalizeAnalytics('x'), null);
  },
  'busyHours sums across agents': function () {
    var h = DashAnalytics.busyHours([
      { byHour: [1].concat(new Array(23).fill(0)) },
      { byHour: [2].concat(new Array(23).fill(0)) }
    ]);
    assert.strictEqual(h.length, 24);
    assert.strictEqual(h[0], 3);
    assert.strictEqual(h[5], 0);
  },
  'fmtDur formats m:ss': function () {
    assert.strictEqual(DashAnalytics.fmtDur(0), '0:00');
    assert.strictEqual(DashAnalytics.fmtDur(61.7), '1:02');
    assert.strictEqual(DashAnalytics.fmtDur(600), '10:00');
  },
  'hourLabel formats 12h clock': function () {
    assert.strictEqual(DashAnalytics.hourLabel(0), '12am');
    assert.strictEqual(DashAnalytics.hourLabel(13), '1pm');
    assert.strictEqual(DashAnalytics.hourLabel(12), '12pm');
  },
  // #42 timeline
  'filterCalls filters by agent and date, newest first': function () {
    var calls = [
      { id: '1', agentId: 'ava', startedAt: '2026-10-12T10:00:00Z' },
      { id: '2', agentId: 'marco', startedAt: '2026-10-13T09:00:00Z' },
      { id: '3', agentId: 'ava', startedAt: '2026-10-13T11:00:00Z' }
    ];
    var byAgent = CallTimeline.filterCalls(calls, { agentId: 'ava', date: '' });
    assert.deepStrictEqual(byAgent.map(function (c) { return c.id; }), ['3', '1']);
    var day = CallTimeline.dayKey('2026-10-13T09:00:00Z');
    var byDate = CallTimeline.filterCalls(calls, { agentId: '', date: day });
    assert.deepStrictEqual(byDate.map(function (c) { return c.id; }), ['3', '2']);
    var both = CallTimeline.filterCalls(calls, { agentId: 'ava', date: day });
    assert.deepStrictEqual(both.map(function (c) { return c.id; }), ['3']);
  },
  'dayKey/dayLabel handle invalid input': function () {
    assert.strictEqual(CallTimeline.dayKey('not-a-date'), '');
    assert.strictEqual(CallTimeline.dayLabel(''), 'Unknown date');
    assert.strictEqual(CallTimeline.dayLabel(CallTimeline.dayKey(Date.now())), 'Today');
  },
  'groupByDay groups and orders newest day first': function () {
    var calls = [
      { id: '1', startedAt: '2026-10-12T10:00:00Z' },
      { id: '2', startedAt: '2026-10-13T09:00:00Z' },
      { id: '3', startedAt: '2026-10-13T11:00:00Z' }
    ];
    var g = CallTimeline.groupByDay(calls);
    assert.strictEqual(g.length, 2);
    assert.strictEqual(g[0].items.length, 2);
    assert.strictEqual(g[1].items.length, 1);
    assert.ok(g[0].key >= g[1].key);
  },
  'agentOptions dedups and sorts by name': function () {
    var opts = CallTimeline.agentOptions([
      { agentId: 'marco', agentName: 'Marco' },
      { agentId: 'ava', agentName: 'Ava' },
      { agentId: 'ava', agentName: 'Ava' },
      { agentId: '', agentName: 'Nobody' }
    ]);
    assert.deepStrictEqual(opts.map(function (o) { return o.id; }), ['ava', 'marco']);
  },
  'DashLayout storage key is per-key': function () {
    var DashLayout = analyticsMod.DashLayout;
    assert.notStrictEqual(DashLayout._storageKey('aaa'), DashLayout._storageKey('bbb'));
    assert.ok(DashLayout._storageKey(null).indexOf('shared') !== -1);
  }
};
