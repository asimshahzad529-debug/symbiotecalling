'use strict';
/* tests/test-v8-appointments.test.js -- v8 #5 appointment booking parser
 * (src/appointments.js) + MemoryStore integration. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var appts = require('../src/appointments');
var MemoryStore = require('../src/memory').MemoryStore;

var FUTURE1 = '2099-03-10T10:00:00+05:00';
var FUTURE2 = '2099-03-12T15:30:00+05:00';
var PAST = '2001-01-01T09:00:00+05:00';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v8appt-'));
}

module.exports = {
  'parseAppointmentNote: valid em-dash line': async function () {
    var p = appts.parseAppointmentNote('APPOINTMENT: 2026-10-20T15:00:00+05:00 \u2014 Dental checkup with Zara');
    assert.ok(p, 'parsed');
    assert.strictEqual(p.title, 'Dental checkup with Zara');
    assert.strictEqual(p.at, new Date(Date.parse('2026-10-20T15:00:00+05:00')).toISOString());
  },

  'parseAppointmentNote: valid with " - " separator': async function () {
    var p = appts.parseAppointmentNote('APPOINTMENT: 2026-11-01 09:00 - Follow-up call');
    assert.ok(p, 'parsed');
    assert.strictEqual(p.title, 'Follow-up call');
    assert.ok(isFinite(Date.parse(p.at)), 'at is valid ISO');
  },

  'parseAppointmentNote: trims surrounding whitespace': async function () {
    var p = appts.parseAppointmentNote('  APPOINTMENT: 2026-10-20T15:00:00Z \u2014 Dentist  ');
    assert.ok(p);
    assert.strictEqual(p.title, 'Dentist');
  },

  'parseAppointmentNote: rejects non-prefixed lines': async function () {
    assert.strictEqual(appts.parseAppointmentNote('Meeting tomorrow at 3pm'), null);
    assert.strictEqual(appts.parseAppointmentNote('appointment: 2026-10-20'), null); // case-sensitive prefix
    assert.strictEqual(appts.parseAppointmentNote('NOTE: APPOINTMENT: 2026-10-20T10:00Z \u2014 x'), null);
  },

  'parseAppointmentNote: rejects unparseable dates and non-strings': async function () {
    assert.strictEqual(appts.parseAppointmentNote('APPOINTMENT: someday soon \u2014 Checkup'), null);
    assert.strictEqual(appts.parseAppointmentNote('APPOINTMENT:'), null);
    assert.strictEqual(appts.parseAppointmentNote('APPOINTMENT:   '), null);
    assert.strictEqual(appts.parseAppointmentNote(null), null);
    assert.strictEqual(appts.parseAppointmentNote(12345), null);
  },

  'parseAppointmentNote: bare datetime without title still parses': async function () {
    var p = appts.parseAppointmentNote('APPOINTMENT: 2026-10-20T10:00:00Z');
    assert.ok(p, 'parsed');
    assert.strictEqual(p.title, '');
  },

  'listAppointments: upcoming-only, sorted ascending': async function () {
    var entries = [{
      id: 'mem_a', agentId: 'ava', agentName: 'Ava', callId: 'call_1', keyHash: 'k',
      notes: [
        { t: '2026-10-13T10:00:00Z', text: 'APPOINTMENT: ' + FUTURE2 + ' \u2014 Second' },
        { t: '2026-10-13T10:01:00Z', text: 'APPOINTMENT: ' + FUTURE1 + ' \u2014 First' },
        { t: '2026-10-13T10:02:00Z', text: 'APPOINTMENT: ' + PAST + ' \u2014 Old, gone' },
        { t: '2026-10-13T10:03:00Z', text: 'just a normal note' }
      ]
    }];
    var list = appts.listAppointments(entries);
    assert.strictEqual(list.length, 2, 'past appointment excluded');
    assert.strictEqual(list[0].title, 'First', 'sorted by at ascending');
    assert.strictEqual(list[1].title, 'Second');
    assert.strictEqual(list[0].agentId, 'ava');
    assert.strictEqual(list[0].callId, 'call_1');
    assert.strictEqual(list[0].memoryId, 'mem_a');
    assert.ok(list[0].note.indexOf('APPOINTMENT:') === 0);
  },

  'listAppointments: includePast keeps everything': async function () {
    var entries = [{
      id: 'mem_b', agentId: 'ava', notes: [
        { t: '2026-10-13T10:00:00Z', text: 'APPOINTMENT: ' + PAST + ' \u2014 Old' }
      ]
    }];
    assert.strictEqual(appts.listAppointments(entries).length, 0);
    assert.strictEqual(appts.listAppointments(entries, { includePast: true }).length, 1);
  },

  'listAppointments: non-array input -> []': async function () {
    assert.deepStrictEqual(appts.listAppointments(null), []);
    assert.deepStrictEqual(appts.listAppointments('nope'), []);
  },

  'MemoryStore.list() entries carry appointments array': async function () {
    var dir = tmpDir();
    var m = new MemoryStore(dir, null);
    var id = await m.beginCall({ keyHash: 'k', agentId: 'ava', agentName: 'Ava', number: '1' });
    await m.addNote(id, 'APPOINTMENT: ' + FUTURE1 + ' \u2014 Dental checkup with Zara');
    await m.addNote(id, 'caller likes morning slots');
    var list = m.list();
    assert.strictEqual(list.length, 1);
    assert.ok(Array.isArray(list[0].appointments), 'appointments array present');
    assert.strictEqual(list[0].appointments.length, 1);
    assert.strictEqual(list[0].appointments[0].title, 'Dental checkup with Zara');
    fs.rmSync(dir, { recursive: true, force: true });
  },

  'MemoryStore.listAppointments() returns upcoming across entries': async function () {
    var dir = tmpDir();
    var m = new MemoryStore(dir, null);
    var id1 = await m.beginCall({ keyHash: 'k', agentId: 'ava', agentName: 'Ava', number: '1' });
    await m.addNote(id1, 'APPOINTMENT: ' + FUTURE1 + ' \u2014 Checkup');
    var id2 = await m.beginCall({ keyHash: 'k', agentId: 'liam', agentName: 'Liam', number: '2' });
    await m.addNote(id2, 'APPOINTMENT: ' + PAST + ' \u2014 Past one');
    var out = m.listAppointments();
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, 'Checkup');
    assert.strictEqual(out[0].agentName, 'Ava');
    assert.strictEqual(out[0].memoryId, id1);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
