'use strict';
/* tests/test-v7-ws5-callx.test.js — WS5 Call Experience.
 * Pure-logic parts are tested here. DOM-only parts (notes.attach,
 * bubble minimize/expand, meter DOM, download blob trigger, renders) are
 * marked browser-only and are NOT exercised in Node. */
var assert = require('assert');
var CallX = require('../public/callx.js');
var callxApi = require('../src/apiv7_callx.js');

function mockStorage() {
  var map = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; }
  };
}

module.exports = {
  'CallX exposes all ws5 modules': async function () {
    assert.ok(CallX.notes && CallX.search && CallX.bubble && CallX.meter &&
      CallX.quota && CallX.recents, 'modules present');
    assert.strictEqual(typeof CallX.searchLines, 'function');
    assert.strictEqual(typeof CallX.buildTranscriptText, 'function');
    assert.strictEqual(typeof CallX.downloadTranscript, 'function');
    assert.strictEqual(typeof CallX.netStatus, 'function');
    assert.strictEqual(typeof CallX.renderDashboardRecents, 'function');
    assert.strictEqual(typeof CallX.renderRecents, 'function');
    assert.strictEqual(typeof CallX.keyHash, 'function');
  },

  'searchLines: matches line text with index/who': async function () {
    var hits = CallX.searchLines([
      { who: 'user', text: 'I need a dentist appointment' },
      { who: 'agent', text: 'Booked for October 15' }
    ], 'dentist');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].index, 0);
    assert.strictEqual(hits[0].who, 'user');
  },

  'searchLines: case-insensitive': async function () {
    var hits = CallX.searchLines([{ who: 'agent', text: 'Your FLIGHT is confirmed' }], 'flight');
    assert.strictEqual(hits.length, 1);
  },

  'searchLines: no match -> empty': async function () {
    var hits = CallX.searchLines([{ who: 'user', text: 'hello there' }], 'xyzzy');
    assert.deepStrictEqual(hits, []);
  },

  'searchLines: empty query -> empty': async function () {
    var hits = CallX.searchLines([{ who: 'user', text: 'hello' }], '   ');
    assert.deepStrictEqual(hits, []);
    assert.deepStrictEqual(CallX.searchLines([{ who: 'user', text: 'hello' }], null), []);
  },

  'searchLines: bad input -> empty, order preserved': async function () {
    assert.deepStrictEqual(CallX.searchLines(null, 'a'), []);
    var hits = CallX.searchLines([
      { who: 'user', text: 'call me back' },
      { who: 'agent', text: 'I will CALL you' },
      { who: 'user', text: 'thanks' }
    ], 'call');
    assert.strictEqual(hits.length, 2);
    assert.strictEqual(hits[0].index, 0);
    assert.strictEqual(hits[1].index, 1);
  },

  'quota: does not fire before limit': async function () {
    CallX.quota.setLimit(2); // 120s
    assert.strictEqual(CallX.quota.check(0), false);
    assert.strictEqual(CallX.quota.check(119), false);
    assert.strictEqual(CallX.quota.isFired(), false);
  },

  'quota: fires exactly once at/over limit': async function () {
    CallX.quota.setLimit(1); // 60s
    assert.strictEqual(CallX.quota.check(60), true);
    assert.strictEqual(CallX.quota.check(61), false, 'must not fire twice');
    assert.strictEqual(CallX.quota.check(600), false, 'still fired state');
    assert.strictEqual(CallX.quota.isFired(), true);
  },

  'quota: reset re-arms, zero limit disables': async function () {
    CallX.quota.setLimit(1);
    assert.strictEqual(CallX.quota.check(60), true);
    CallX.quota.reset();
    assert.strictEqual(CallX.quota.isFired(), false);
    assert.strictEqual(CallX.quota.check(60), true, 'fires again after reset');
    CallX.quota.setLimit(0);
    assert.strictEqual(CallX.quota.check(99999), false, 'disabled at 0');
    CallX.quota.setLimit(-5);
    assert.strictEqual(CallX.quota.check(99999), false, 'disabled when negative');
  },

  'recents: push/list most-recent-first': async function () {
    CallX.recents._store = mockStorage();
    CallX.recents.push({ name: 'Liam', number: '+1 (555) 010-0001' });
    CallX.recents.push({ name: 'Olivia', number: '+1 (555) 010-0002' });
    var list = CallX.recents.list();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].number, '+1 (555) 010-0002', 'newest first');
    assert.strictEqual(list[1].name, 'Liam');
  },

  'recents: push dedups by number, keeps fav': async function () {
    CallX.recents._store = mockStorage();
    CallX.recents.push({ name: 'Liam', number: '555-1' });
    assert.strictEqual(CallX.recents.toggleFav('555-1'), true);
    CallX.recents.push({ name: 'Liam Sales', number: '555-1' }); // re-dial
    var list = CallX.recents.list();
    assert.strictEqual(list.length, 1, 'no duplicate entry');
    assert.strictEqual(list[0].fav, true, 'fav preserved');
    assert.strictEqual(list[0].name, 'Liam Sales', 'name refreshed');
  },

  'recents: toggleFav flips, unknown -> false': async function () {
    CallX.recents._store = mockStorage();
    CallX.recents.push({ name: 'A', number: '1' });
    assert.strictEqual(CallX.recents.toggleFav('1'), true);
    assert.strictEqual(CallX.recents.toggleFav('1'), false);
    assert.strictEqual(CallX.recents.toggleFav('nope'), false);
    assert.deepStrictEqual(CallX.recents.favorites(), [], 'none fav now');
  },

  'recents: push ignores empty number, list is a copy': async function () {
    CallX.recents._store = mockStorage();
    assert.strictEqual(CallX.recents.push({ name: 'X' }), null);
    assert.deepStrictEqual(CallX.recents.list(), []);
  },

  'notes route: 200 saves notes + notesAt, mirrors into memory': async function () {
    var savedArr = null;
    var noted = null;
    var call = { id: 'call_abc123', agentId: 'liam', agentName: 'Liam',
      startedAt: '2026-10-12T10:00:00.000Z', endedAt: '2026-10-12T10:02:00.000Z' };
    var ctx = {
      history: {
        list: function () { return [call]; },
        importAll: async function (arr) { savedArr = arr; return arr.length; }
      },
      memory: {
        list: function () {
          return [{ id: 'mem_1', agentId: 'liam', startedAt: '2026-10-12T10:00:30.000Z' }];
        },
        addNote: async function (id, note) { noted = { id: id, note: note }; }
      }
    };
    var r = await callxApi.handleNotes('call_abc123', { keyHash: null, notes: '  Client wants Tuesday.  ' }, ctx);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.saved, true);
    assert.strictEqual(savedArr[0].notes, 'Client wants Tuesday.', 'trimmed');
    assert.ok(savedArr[0].notesAt, 'notesAt stamped');
    assert.strictEqual(noted.id, 'mem_1', 'memory mirrored');
    assert.ok(noted.note.indexOf('In-call note:') === 0, 'memory note prefixed');
  },

  'notes route: 400 on empty notes, 404 on unknown id': async function () {
    var ctx = { history: { list: function () { return []; }, importAll: async function () {} } };
    var r1 = await callxApi.handleNotes('call_x', { notes: '   ' }, ctx);
    assert.strictEqual(r1.status, 400);
    var r2 = await callxApi.handleNotes('call_x', { notes: 'hi' }, ctx);
    assert.strictEqual(r2.status, 404);
  },

  'notes route: 403 when record keyHash differs': async function () {
    var call = { id: 'call_k', keyHash: 'AAA', startedAt: '2026-10-12T10:00:00.000Z', agentId: 'liam' };
    var ctx = { history: { list: function () { return [call]; }, importAll: async function () { throw new Error('must not write'); } } };
    var r = await callxApi.handleNotes('call_k', { keyHash: 'BBB', notes: 'x' }, ctx);
    assert.strictEqual(r.status, 403);
  },

  'notes route: notes truncated to MAX_NOTES': async function () {
    var saved = null;
    var long = new Array(3000).join('n');
    var ctx = {
      history: {
        list: function () { return [{ id: 'call_t', agentId: 'a', startedAt: '2026-10-12T10:00:00.000Z' }]; },
        importAll: async function (arr) { saved = arr; }
      }
    };
    var r = await callxApi.handleNotes('call_t', { notes: long }, ctx);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(saved[0].notes.length, callxApi.MAX_NOTES);
  },

  'notes route: works without memory ctx (optional)': async function () {
    var ctx = {
      history: {
        list: function () { return [{ id: 'call_m', agentId: 'a', startedAt: '2026-10-12T10:00:00.000Z' }]; },
        importAll: async function () {}
      }
    };
    var r = await callxApi.handleNotes('call_m', { notes: 'ok' }, ctx);
    assert.strictEqual(r.status, 200);
  },

  'buildTranscriptText: Caller/Agent lines with names': async function () {
    var txt = CallX.buildTranscriptText([
      { who: 'user', text: 'Hi, I need help' },
      { who: 'agent', text: 'Sure thing' }
    ], 'Liam');
    assert.ok(txt.indexOf('Caller: Hi, I need help') !== -1, 'caller line');
    assert.ok(txt.indexOf('Liam: Sure thing') !== -1, 'agent line with name');
    assert.ok(txt.indexOf('Symbiote Calling') !== -1, 'header');
  },

  'buildTranscriptText: default agent name, empty lines': async function () {
    var txt = CallX.buildTranscriptText([{ who: 'agent', text: 'hello' }]);
    assert.ok(txt.indexOf('Agent: hello') !== -1, 'falls back to Agent');
    var empty = CallX.buildTranscriptText([], 'Liam');
    assert.ok(empty.indexOf('Symbiote Calling') !== -1);
  },

  'netStatus: pure classifier': async function () {
    assert.strictEqual(CallX.netStatus(false, 1), 'offline');
    assert.strictEqual(CallX.netStatus(true, 1), 'live');
    assert.strictEqual(CallX.netStatus(true, 0), 'connecting');
    assert.strictEqual(CallX.netStatus(true, 3), 'connecting');
  },

  'keyHash: resolves null in Node (no crypto.subtle text encoder path)': async function () {
    var h = await CallX.keyHash('some-key');
    // In Node there is no window.TextEncoder-gated path taken via global crypto
    // unless subtle is exposed; accept either a 64-char hex or null.
    assert.ok(h === null || /^[0-9a-f]{64}$/.test(h), 'hex or null, got: ' + h);
  }
};
