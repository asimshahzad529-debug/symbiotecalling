'use strict';
/**
 * src/appointments.js — v8 #5 appointment booking (pure parser, no I/O).
 *
 * Convention: agents capture appointments during calls with the EXISTING
 * save_note tool — no new Live tool. The agent writes a note line starting
 * with "APPOINTMENT:", e.g.
 *   "APPOINTMENT: 2026-10-20T15:00:00+05:00 — Dental checkup with Zara"
 *
 * parseAppointmentNote(text) -> { at, title } | null
 *   at: ISO 8601 string (UTC) parsed from the line; null when the line is
 *   not an appointment note or the date is unparseable.
 *
 * entryAppointments(entry) -> [{ at, title, note, noteAt }] (all, asc)
 * listAppointments(entries, opts) -> [{ id, agentId, agentName, title, at,
 *   note, callId, memoryId, noteAt }] upcoming-only, sorted by `at` asc.
 *   opts.includePast (default false) keeps past appointments too.
 */

var PREFIX = 'APPOINTMENT:';

// Separators between the datetime and the title, tried in order. Em/en
// dashes are tried first because ISO datetimes never contain them, so the
// split is unambiguous. (' - ' is tried last because a title may contain
// hyphens — but an ISO datetime never contains ' - ' with spaces.)
var SEPARATORS = ['\u2014', '\u2013', '--', ' - ', ' | ', ' :: '];

function parseAppointmentNote(text) {
  if (typeof text !== 'string') return null;
  var t = text.trim();
  if (t.indexOf(PREFIX) !== 0) return null;
  var rest = t.slice(PREFIX.length).trim();
  if (!rest) return null;

  var datePart = null, title = '';
  for (var i = 0; i < SEPARATORS.length; i++) {
    var sep = SEPARATORS[i];
    var idx = rest.indexOf(sep);
    if (idx > 0) {
      var left = rest.slice(0, idx).trim();
      var ms = Date.parse(left);
      if (isFinite(ms)) {
        datePart = ms;
        title = rest.slice(idx + sep.length).trim();
        break;
      }
    }
  }
  if (datePart === null) {
    // Last resort: the whole line is just a datetime, no title.
    var whole = Date.parse(rest);
    if (!isFinite(whole)) return null;
    datePart = whole;
    title = '';
  }
  return { at: new Date(datePart).toISOString(), title: title };
}

/**
 * All appointments parsed from one memory entry's notes, oldest `at`
 * first. `entry.notes` is [{ t, text }]; noteIndex gives stable ids.
 */
function entryAppointments(entry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.notes)) return [];
  var out = [];
  for (var i = 0; i < entry.notes.length; i++) {
    var n = entry.notes[i];
    if (!n || typeof n.text !== 'string') continue;
    var p = parseAppointmentNote(n.text);
    if (!p) continue;
    out.push({
      id: (entry.id ? String(entry.id) : 'mem_unknown') + '_appt_' + i,
      agentId: entry.agentId || null,
      agentName: entry.agentName || null,
      title: p.title,
      at: p.at,
      note: String(n.text).slice(0, 500),
      noteAt: n.t || null,
      callId: entry.callId || null,
      memoryId: entry.id || null
    });
  }
  out.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  return out;
}

/**
 * Upcoming appointments across many memory entries, sorted by `at`
 * ascending. Entries within the last 60 seconds are still "upcoming"
 * (a call that just booked something starting now). Pass
 * { includePast: true } to keep everything.
 */
function listAppointments(entries, opts) {
  if (!Array.isArray(entries)) return [];
  opts = opts || {};
  var cutoff = opts.includePast ? -Infinity : Date.now() - 60000;
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var appts = entryAppointments(entries[i]);
    for (var j = 0; j < appts.length; j++) {
      if (Date.parse(appts[j].at) >= cutoff) out.push(appts[j]);
    }
  }
  out.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  return out;
}

module.exports = {
  PREFIX: PREFIX,
  parseAppointmentNote: parseAppointmentNote,
  entryAppointments: entryAppointments,
  listAppointments: listAppointments
};
