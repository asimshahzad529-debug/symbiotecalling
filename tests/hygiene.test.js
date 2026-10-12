'use strict';
/* tests/hygiene.test.js — v7 WS7 hygiene (client side):
 * public/hygiene.js — accent picker, retention, history filters. */
var assert = require('assert');

var Hygiene = require('../public/hygiene');

function mkCall(id, agentId, startedAt, durationSec, endedAt) {
  return { id: id, agentId: agentId, agentName: agentId, startedAt: startedAt,
           endedAt: endedAt === undefined ? startedAt : endedAt, durationSec: durationSec };
}

var CALLS = [
  mkCall('c1', 'lina', '2026-10-01T10:00:00.000Z', 120),   // completed
  mkCall('c2', 'lina', '2026-10-05T10:00:00.000Z', 0),     // missed (ended, 0s)
  mkCall('c3', 'kai',  '2026-10-08T10:00:00.000Z', 45),   // completed
  mkCall('c4', 'kai',  '2026-10-11T10:00:00.000Z', 0, null) // in progress-ish, no duration
];

module.exports = {
  'sanitizeAccent accepts #rrggbb': function () {
    assert.strictEqual(Hygiene.sanitizeAccent('#0e7490'), '#0e7490');
  },
  'sanitizeAccent expands #rgb shorthand': function () {
    assert.strictEqual(Hygiene.sanitizeAccent('#abc'), '#aabbcc');
  },
  'sanitizeAccent rejects garbage -> default': function () {
    assert.strictEqual(Hygiene.sanitizeAccent('red'), Hygiene.DEFAULT_ACCENT);
    assert.strictEqual(Hygiene.sanitizeAccent('#zzzzzz'), Hygiene.DEFAULT_ACCENT);
    assert.strictEqual(Hygiene.sanitizeAccent(null), Hygiene.DEFAULT_ACCENT);
    assert.strictEqual(Hygiene.sanitizeAccent(''), Hygiene.DEFAULT_ACCENT);
  },
  'sanitizeAccent normalizes case': function () {
    assert.strictEqual(Hygiene.sanitizeAccent('#BE123C'), '#be123c');
  },
  'accentSoft produces rgba tint of the accent': function () {
    assert.strictEqual(Hygiene.accentSoft('#6d28d9'), 'rgba(109,40,217,0.12)');
    assert.strictEqual(Hygiene.accentSoft('#000000'), 'rgba(0,0,0,0.12)');
  },
  'ACCENTS lists 8 presets starting with the default': function () {
    assert.ok(Array.isArray(Hygiene.ACCENTS) && Hygiene.ACCENTS.length === 8);
    assert.strictEqual(Hygiene.ACCENTS[0], Hygiene.DEFAULT_ACCENT);
    Hygiene.ACCENTS.forEach(function (c) { assert.strictEqual(Hygiene.sanitizeAccent(c), c); });
  },
  'getRetentionDays defaults to 30 without DOM': function () {
    assert.strictEqual(Hygiene.getRetentionDays(), 30);
  },
  'setRetentionDays clamps without DOM and returns the value': function () {
    assert.strictEqual(Hygiene.setRetentionDays(7), 7);
    assert.strictEqual(Hygiene.setRetentionDays(0), 30);
    assert.strictEqual(Hygiene.setRetentionDays('abc'), 30);
  },
  'isOlderThan mirrors server behavior': function () {
    var now = Date.parse('2026-10-12T12:00:00Z');
    assert.strictEqual(Hygiene.isOlderThan('2026-09-01T00:00:00Z', 30, now), true);
    assert.strictEqual(Hygiene.isOlderThan('2026-10-10T00:00:00Z', 30, now), false);
    assert.strictEqual(Hygiene.isOlderThan(null, 30, now), false);
  },
  'callStatus: completed vs missed': function () {
    assert.strictEqual(Hygiene.callStatus(CALLS[0]), 'completed');
    assert.strictEqual(Hygiene.callStatus(CALLS[1]), 'missed');
    assert.strictEqual(Hygiene.callStatus(CALLS[2]), 'completed');
  },
  'filterHistory: no filters returns everything': function () {
    assert.strictEqual(Hygiene.filterHistory(CALLS, {}).length, 4);
    assert.strictEqual(Hygiene.filterHistory(CALLS).length, 4);
  },
  'filterHistory: by agentId': function () {
    var r = Hygiene.filterHistory(CALLS, { agentId: 'lina' });
    assert.deepStrictEqual(r.map(function (c) { return c.id; }), ['c1', 'c2']);
  },
  'filterHistory: status completed': function () {
    var r = Hygiene.filterHistory(CALLS, { status: 'completed' });
    assert.deepStrictEqual(r.map(function (c) { return c.id; }), ['c1', 'c3']);
  },
  'filterHistory: status missed': function () {
    var r = Hygiene.filterHistory(CALLS, { status: 'missed' });
    assert.ok(r.some(function (c) { return c.id === 'c2'; }), 'ended 0s call is missed');
  },
  'filterHistory: date range inclusive': function () {
    var r = Hygiene.filterHistory(CALLS, { from: '2026-10-05', to: '2026-10-08' });
    assert.deepStrictEqual(r.map(function (c) { return c.id; }), ['c2', 'c3']);
  },
  'filterHistory: combined agent + status + date': function () {
    var r = Hygiene.filterHistory(CALLS, { agentId: 'kai', status: 'completed', from: '2026-10-01', to: '2026-10-10' });
    assert.deepStrictEqual(r.map(function (c) { return c.id; }), ['c3']);
  },
  'filterHistory: non-array input -> []': function () {
    assert.deepStrictEqual(Hygiene.filterHistory(null, {}), []);
  }
};
