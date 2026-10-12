'use strict';
/**
 * src/apiv7_callx.js — WS5 "Call Experience" server routes (v7.0.0).
 *
 * POST /api/v7/calls/:id/notes  { keyHash, notes }
 *   Saves in-call notes into the call record and mirrors them into the
 *   matching memory entry (trivial case only — best effort, never fatal).
 *
 * MOUNT (integrator, in server.js handlePost before the final 404):
 *   var callxApi = require('./src/apiv7_callx');
 *   var m = callxApi.NOTES_ROUTE.exec(p);
 *   if (m) {
 *     callxApi.handleNotes(m[1], body, { history: history, memory: memory })
 *       .then(function (r) { sendJson(res, r.status, r.body); })
 *       .catch(function () { sendJson(res, 500, { error: 'server error' }); });
 *     return;
 *   }
 * ctx fields: history — src/store.js CallHistory (required);
 *             memory  — src/memory.js MemoryStore (optional).
 *
 * v7 KEY-PARTITION NOTE (sibling workstream): CallHistory is now constructed
 * per-keyHash — new CallHistory(DATA_DIR, keyHash) reads/writes
 * DATA_DIR/calls_<keyHash>.json. The integrator MUST pass the CALLER's
 * scoped instance as ctx.history so notes land in that key's file (and the
 * same instance for the legacy shared file when constructed without a
 * keyHash). This module only uses list() + importAll(), so it works with
 * either construction unchanged.
 *
 * ASSUMPTIONS (documented):
 *  - Call records live in <DATA_DIR>/calls.json as managed by
 *    CallHistory (src/store.js). This module never writes the file itself;
 *    it reuses history.list() + history.importAll() so the write goes
 *    through store.js's own serialized atomic (temp + rename) queue —
 *    no store.js changes required.
 *  - Notes are stored on the call record as `notes` (+ `notesAt` timestamp),
 *    truncated to MAX_NOTES (2000) chars — same truncation convention as
 *    CallHistory.setSummary.
 *  - keyHash is enforced ONLY if the call record itself carries a keyHash
 *    field (v7 key-scoping may add it): body.keyHash must match then.
 *    If the record has no keyHash, the field is accepted and ignored.
 *  - Memory mirroring reuses the same matching rule as the summary route
 *    in server.js: same agentId and startedAt within 120s. Notes go in via
 *    MemoryStore.addNote(id, 'In-call note: ...').
 */

var NOTES_ROUTE = /^\/api\/v7\/calls\/([A-Za-z0-9_-]+)\/notes$/;
var MAX_NOTES = 2000;

function findMemoryEntry(memory, call, scope) {
  if (!memory || typeof memory.list !== 'function') return null;
  var mems;
  try { mems = memory.list(scope); } catch (e) { return null; }
  if (!Array.isArray(mems)) return null;
  for (var i = 0; i < mems.length; i++) {
    var m = mems[i];
    if (m && m.agentId === call.agentId &&
        Math.abs(Date.parse(m.startedAt) - Date.parse(call.startedAt)) < 120000) {
      return m;
    }
  }
  return null;
}

/**
 * handleNotes(callId, body, ctx) -> Promise<{status, body}>.
 * Never throws; every failure path returns a status object instead.
 */
async function handleNotes(callId, body, ctx) {
  if (!ctx || !ctx.history || typeof ctx.history.list !== 'function' ||
      typeof ctx.history.importAll !== 'function') {
    return { status: 500, body: { error: 'notes api not mounted: history missing' } };
  }
  var notes = body && typeof body.notes === 'string' ? body.notes.trim() : '';
  if (!notes) return { status: 400, body: { error: 'notes required' } };
  var keyHash = body && typeof body.keyHash === 'string' && body.keyHash ? body.keyHash : null;

  var calls;
  try { calls = ctx.history.list(); }
  catch (e) { return { status: 500, body: { error: 'history read failed' } }; }
  if (!Array.isArray(calls)) return { status: 500, body: { error: 'history read failed' } };

  var call = null;
  for (var i = 0; i < calls.length; i++) {
    if (calls[i] && calls[i].id === callId) { call = calls[i]; break; }
  }
  if (!call) return { status: 404, body: { error: 'call not found' } };
  if (keyHash && call.keyHash && call.keyHash !== keyHash) {
    return { status: 403, body: { error: 'key mismatch' } };
  }

  call.notes = notes.slice(0, MAX_NOTES);
  call.notesAt = new Date().toISOString();

  try {
    await ctx.history.importAll(calls);
  } catch (e) {
    return { status: 500, body: { error: 'notes save failed' } };
  }

  // Mirror into the matching memory entry — best effort, non-fatal.
  if (ctx.memory && typeof ctx.memory.list === 'function' && typeof ctx.memory.addNote === 'function') {
    try {
      var mem = findMemoryEntry(ctx.memory, call, keyHash || call.keyHash || null);
      if (mem) await ctx.memory.addNote(mem.id, 'In-call note: ' + notes.slice(0, 500));
    } catch (e) { /* non-fatal */ }
  }

  return { status: 200, body: { saved: true } };
}

module.exports = {
  NOTES_ROUTE: NOTES_ROUTE,
  MAX_NOTES: MAX_NOTES,
  handleNotes: handleNotes
};
