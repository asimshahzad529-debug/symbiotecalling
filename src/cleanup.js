'use strict';
/**
 * src/cleanup.js — v7 data-retention helpers (WS7 hygiene).
 *
 * Pure, node-testable logic shared by server startup + the daily prune:
 *   isOlderThan(iso, days, nowMs)  -> true when the timestamp is strictly
 *                                      older than `days` days
 *   filterFresh(records, days, nowMs) -> records whose startedAt is within
 *                                      the retention window (records with
 *                                      no/invalid startedAt are kept)
 *   retentionDays(raw)             -> normalized retention days, default 30
 *
 * The actual file pruning lives on the stores:
 *   CallHistory.pruneOlderThan(days) / CallHistory.pruneAll(dataDir, days)
 *   MemoryStore.pruneOlderThan(days) / MemoryStore.pruneAll(dataDir, days)
 */

var DEFAULT_RETENTION_DAYS = 30;
var DAY_MS = 24 * 60 * 60 * 1000;

function retentionDays(raw) {
  var n = parseInt(raw, 10);
  if (!isFinite(n) || n < 1) return DEFAULT_RETENTION_DAYS;
  if (n > 3650) return 3650;
  return n;
}

function isOlderThan(iso, days, nowMs) {
  if (iso == null || iso === '') return false;
  var t = Date.parse(iso);
  if (isNaN(t)) return false;
  var now = typeof nowMs === 'number' ? nowMs : Date.now();
  var d = typeof days === 'number' && days >= 1 ? days : DEFAULT_RETENTION_DAYS;
  return (now - t) > d * DAY_MS;
}

function filterFresh(records, days, nowMs) {
  if (!Array.isArray(records)) return [];
  return records.filter(function (r) {
    if (!r || typeof r !== 'object') return false;
    return !isOlderThan(r.startedAt, days, nowMs);
  });
}

module.exports = {
  DAY_MS: DAY_MS,
  DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS,
  retentionDays: retentionDays,
  isOlderThan: isOlderThan,
  filterFresh: filterFresh
};
