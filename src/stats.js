'use strict';
/**
 * src/stats.js — dashboard stats aggregation for Symbiote Calling.
 *
 * Pure, clean-room functions over call-history entries
 * ({id, agentId, agentName, number, startedAt, endedAt, durationSec})
 * and memory entries (same shape plus notes:[{t,text}], transcript:[...]).
 * No I/O, no secrets.
 *
 * computeStats(calls, memories) returns:
 * {
 *   totalCalls:   <number>,  // calls.length
 *   totalMinutes: <number>,  // Math.round(sum(durationSec || 0) / 60)
 *   leadsCaptured: <number>, // total notes on memories with agentId === 'symagent'
 *   topAgents: [              // top 5 by call count, tie-break by minutes desc
 *     { agentId, agentName, number, calls, minutes }, ...
 *   ]
 * }
 * Non-array inputs yield zeroed stats. Missing fields default sensibly:
 * durationSec || 0, agentName falls back to agentId or 'Unknown',
 * number falls back to ''.
 */

function zeroed() {
  return { totalCalls: 0, totalMinutes: 0, leadsCaptured: 0, topAgents: [] };
}

function durOf(entry) {
  var d = entry && Number(entry.durationSec);
  return (isFinite(d) && d > 0) ? Math.round(d) : 0;
}

function displayName(agentId, agentName) {
  if (agentName && String(agentName).trim()) return String(agentName);
  if (agentId && String(agentId).trim()) return String(agentId);
  return 'Unknown';
}

function computeStats(calls, memories) {
  if (!Array.isArray(calls) || !Array.isArray(memories)) return zeroed();

  var totalCalls = calls.length;
  var totalSec = 0;
  var byAgent = {};

  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    if (!c || typeof c !== 'object') continue;
    var d = durOf(c);
    totalSec += d;
    var aid = c.agentId ? String(c.agentId) : '';
    var key = aid || ('__anon_' + i);
    var agg = byAgent[key];
    if (!agg) {
      agg = {
        agentId: aid,
        agentName: displayName(aid, c.agentName),
        number: c.number ? String(c.number) : '',
        calls: 0,
        seconds: 0
      };
      byAgent[key] = agg;
    }
    agg.calls += 1;
    agg.seconds += d;
    if (!agg.number && c.number) agg.number = String(c.number);
  }

  var topAgents = Object.keys(byAgent).map(function (k) {
    var a = byAgent[k];
    return {
      agentId: a.agentId,
      agentName: a.agentName,
      number: a.number,
      calls: a.calls,
      minutes: Math.round(a.seconds / 60)
    };
  });
  topAgents.sort(function (a, b) {
    if (b.calls !== a.calls) return b.calls - a.calls;
    return b.minutes - a.minutes;
  });

  var leadsCaptured = 0;
  for (var j = 0; j < memories.length; j++) {
    var m = memories[j];
    if (!m || typeof m !== 'object') continue;
    if (String(m.agentId || '') !== 'symagent') continue;
    if (Array.isArray(m.notes)) leadsCaptured += m.notes.length;
  }

  return {
    totalCalls: totalCalls,
    totalMinutes: Math.round(totalSec / 60),
    leadsCaptured: leadsCaptured,
    topAgents: topAgents.slice(0, 5)
  };
}

/**
 * v8 #4 server-side analytics (consumed by the dashboard frontend).
 * computeAnalytics(calls) returns EXACTLY:
 * {
 *   agents: [ { agentId, name, calls, avgSecs, byHour: [24] }, ... ],
 *   totals: { calls, minutes }
 * }
 * - agents: every agent seen in the history, sorted by calls desc
 *   (tie-break by minutes desc). avgSecs is the mean duration, rounded.
 * - byHour: call counts per hour of day from startedAt, in the SERVER's
 *   local timezone (buckets 0..23); entries with unparseable startedAt are
 *   counted in calls but not in any hour bucket.
 * - totals: total calls and total minutes (rounded) across all calls.
 * Non-array input -> zeroed shape. Pure, no I/O, no secrets.
 */
function computeAnalytics(calls) {
  if (!Array.isArray(calls)) return { agents: [], totals: { calls: 0, minutes: 0 } };

  var totalCalls = 0;
  var totalSec = 0;
  var byAgent = {};

  for (var i = 0; i < calls.length; i++) {
    var c = calls[i];
    if (!c || typeof c !== 'object') continue;
    var d = durOf(c);
    totalCalls += 1;
    totalSec += d;
    var aid = c.agentId ? String(c.agentId) : '';
    var key = aid || ('__anon_' + i);
    var agg = byAgent[key];
    if (!agg) {
      agg = {
        agentId: aid,
        agentName: displayName(aid, c.agentName),
        number: c.number ? String(c.number) : '',
        calls: 0,
        seconds: 0,
        byHour: new Array(24).fill(0)
      };
      byAgent[key] = agg;
    }
    agg.calls += 1;
    agg.seconds += d;
    if (!agg.number && c.number) agg.number = String(c.number);
    var h = new Date(c.startedAt).getHours();
    if (isFinite(h) && h >= 0 && h <= 23) agg.byHour[h] += 1;
  }

  var agents = Object.keys(byAgent).map(function (k) {
    var a = byAgent[k];
    return {
      agentId: a.agentId,
      name: a.agentName,
      calls: a.calls,
      avgSecs: a.calls ? Math.round(a.seconds / a.calls) : 0,
      byHour: a.byHour
    };
  });
  agents.sort(function (a, b) {
    if (b.calls !== a.calls) return b.calls - a.calls;
    var ba = b.calls ? b.avgSecs * b.calls : 0;
    var aa = a.calls ? a.avgSecs * a.calls : 0;
    return ba - aa;
  });

  return {
    agents: agents,
    totals: { calls: totalCalls, minutes: Math.round(totalSec / 60) }
  };
}

module.exports = { computeStats: computeStats, computeAnalytics: computeAnalytics };
