'use strict';
/* tests/stats.test.js — dashboard stats aggregation (src/stats.js). */
var assert = require('assert');
var statsMod = require('../src/stats');
var computeStats = statsMod.computeStats;

function call(agentId, agentName, number, durationSec) {
  return {
    id: 'call_' + agentId + '_' + Math.random().toString(36).slice(2, 8),
    agentId: agentId, agentName: agentName, number: number,
    startedAt: '2026-10-12T07:00:00.000Z', endedAt: '2026-10-12T07:01:00.000Z',
    durationSec: durationSec
  };
}

function memory(agentId, noteCount) {
  var notes = [];
  for (var i = 0; i < noteCount; i++) notes.push({ t: '2026-10-12T07:00:00.000Z', text: 'note ' + i });
  return {
    id: 'mem_' + agentId + '_' + i,
    agentId: agentId, agentName: agentId, number: '+1 (555) 010-0000',
    startedAt: '2026-10-12T07:00:00.000Z', endedAt: '2026-10-12T07:01:00.000Z',
    durationSec: 60, notes: notes, transcript: []
  };
}

module.exports = {
  'empty arrays give all zeros': async function () {
    assert.deepStrictEqual(computeStats([], []), {
      totalCalls: 0, totalMinutes: 0, leadsCaptured: 0, topAgents: []
    });
  },

  'totals: 3 calls with durations 60/120/null': async function () {
    var s = computeStats([
      call('a', 'Ava', '+1 (555) 010-0001', 60),
      call('b', 'Liam', '+1 (555) 010-0002', 120),
      call('c', 'Nova', '+1 (555) 010-0003', null)
    ], []);
    assert.strictEqual(s.totalCalls, 3);
    assert.strictEqual(s.totalMinutes, 3); // round(180 / 60)
    assert.strictEqual(s.leadsCaptured, 0);
  },

  'topAgents: 7 agents -> exactly 5, ordered by calls desc, entry shape': async function () {
    var agents = [
      ['a1', 'Alpha', 1, 60], ['a2', 'Beta', 5, 300], ['a3', 'Gamma', 3, 600],
      ['a4', 'Delta', 2, 120], ['a5', 'Epsilon', 4, 240], ['a6', 'Zeta', 6, 60],
      ['a7', 'Eta', 2, 900]
    ];
    var calls = [];
    agents.forEach(function (a, idx) {
      for (var i = 0; i < a[2]; i++) {
        calls.push(call(a[0], a[1], '+1 (555) 010-00' + idx, a[3]));
      }
    });
    var s = computeStats(calls, []);
    assert.strictEqual(s.totalCalls, 1 + 5 + 3 + 2 + 4 + 6 + 2);
    assert.strictEqual(s.topAgents.length, 5);
    var counts = s.topAgents.map(function (t) { return t.calls; });
    assert.deepStrictEqual(counts, [6, 5, 4, 3, 2]);
    s.topAgents.forEach(function (t) {
      assert.deepStrictEqual(Object.keys(t).sort(), ['agentId', 'agentName', 'calls', 'minutes', 'number']);
      assert.strictEqual(typeof t.agentId, 'string');
      assert.strictEqual(typeof t.agentName, 'string');
      assert.strictEqual(typeof t.number, 'string');
      assert.strictEqual(typeof t.calls, 'number');
      assert.strictEqual(typeof t.minutes, 'number');
    });
    // tie at 2 calls: a7 (900s = 15 min each) beats a4 (120s = 2 min each) on minutes desc
    assert.strictEqual(s.topAgents[4].agentId, 'a7');
  },

  'leadsCaptured counts only notes on symagent memories': async function () {
    var mems = [
      memory('symagent', 2),
      memory('ava', 5),
      memory('symagent', 1),
      { id: 'mem_x', agentId: 'symagent', agentName: 'SymAgent', number: '', notes: null }
    ];
    var s = computeStats([], mems);
    assert.strictEqual(s.leadsCaptured, 3);
  },

  'non-array inputs do not throw and give zeroed stats': async function () {
    var z = { totalCalls: 0, totalMinutes: 0, leadsCaptured: 0, topAgents: [] };
    assert.deepStrictEqual(computeStats(null, []), z);
    assert.deepStrictEqual(computeStats([], undefined), z);
    assert.deepStrictEqual(computeStats('nope', {}), z);
  },

  'missing fields default sensibly': async function () {
    var s = computeStats([{ agentId: 'x' }], []);
    assert.strictEqual(s.totalCalls, 1);
    assert.strictEqual(s.totalMinutes, 0);
    assert.strictEqual(s.topAgents.length, 1);
    assert.strictEqual(s.topAgents[0].agentName, 'x'); // falls back to agentId
    assert.strictEqual(s.topAgents[0].number, '');
    assert.strictEqual(s.topAgents[0].minutes, 0);
  }
};
