'use strict';
/**
 * src/sentiment.js -- v8 #11 caller sentiment + lead hotness scoring.
 *
 * Dependency-free, defensive: scoring NEVER throws and NEVER breaks call
 * saving. Flow:
 *
 *   MemoryStore.setSummary() (src/memory.js) fires this module's
 *   scoreAndSave(store, memoryId, summaryText) fire-and-forget. If a
 *   server Gemini key is configured (GEMINI_API_KEY env), a cheap text
 *   model scores the call; otherwise the call is left unscored and marked
 *   'UNVERIFIED-LIVE'. Any model failure falls back to a local lexical
 *   heuristic ('lexical-fallback') rather than leaving the caller hanging.
 *
 * Pure, testable helpers:
 *   lexicalScore(text)      -> { sentiment: -1..1, leadHotness: 0..1 }
 *   parseScoreJson(text)    -> { sentiment, leadHotness } | null
 *   scoresFromEntries(list) -> [{ callId, agentId, sentiment, leadHotness, at }]
 *
 * scoreAndSave(store, id, summaryText) persists via store.setScores() and
 * resolves { sentiment, leadHotness, status }; it never rejects.
 */

var https = require('https');

var SENTIMENT_MODEL = process.env.SYM_SENTIMENT_MODEL || 'gemini-2.5-flash';
var MODEL_TIMEOUT_MS = 10000;

var POSITIVE_WORDS = [
  'love', 'loved', 'great', 'amazing', 'excellent', 'perfect', 'fantastic',
  'happy', 'satisfied', 'awesome', 'wonderful', 'glad', 'impressed',
  'pleased', 'delighted', 'interested', 'excited', 'definitely', 'absolutely'
];
var NEGATIVE_WORDS = [
  'hate', 'hated', 'terrible', 'awful', 'bad', 'worst', 'angry', 'furious',
  'frustrated', 'disappointed', 'annoyed', 'horrible', 'useless', 'poor',
  'waste', 'cancel', 'complaint', 'refund', 'rude', 'never again'
];
var HOT_LEAD_WORDS = [
  'book', 'buy', 'price', 'pricing', 'cost', 'quote', 'demo', 'signup',
  'sign up', 'subscribe', 'purchase', 'order', 'hire', 'deal', 'proposal',
  'schedule', 'callback', 'call me', 'contact me', 'email me', 'send me',
  'interested', 'how much', 'get started'
];

function round2(n) { return Math.round(n * 100) / 100; }

function countHits(lower, words) {
  var hits = 0;
  for (var i = 0; i < words.length; i++) {
    if (lower.indexOf(words[i]) !== -1) hits++;
  }
  return hits;
}

/** Pure lexical heuristic. Always returns clamped numbers, never throws. */
function lexicalScore(text) {
  var lower = String(text || '').toLowerCase();
  var pos = countHits(lower, POSITIVE_WORDS);
  var neg = countHits(lower, NEGATIVE_WORDS);
  var hot = countHits(lower, HOT_LEAD_WORDS);
  var sentiment = (pos === 0 && neg === 0) ? 0 : (pos - neg) / (pos + neg);
  var leadHotness = Math.min(1, hot / 3);
  return {
    sentiment: round2(Math.max(-1, Math.min(1, sentiment))),
    leadHotness: round2(leadHotness)
  };
}

/** Parse a model response like {"sentiment":0.4,"leadHotness":0.8}. Null on garbage. */
function parseScoreJson(text) {
  if (typeof text !== 'string') return null;
  var m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  var obj;
  try { obj = JSON.parse(m[0]); } catch (e) { return null; }
  var s = Number(obj.sentiment), l = Number(obj.leadHotness);
  if (!isFinite(s) || !isFinite(l)) return null;
  return {
    sentiment: round2(Math.max(-1, Math.min(1, s))),
    leadHotness: round2(Math.max(0, Math.min(1, l)))
  };
}

/**
 * Raw memory entries -> the GET /api/v8/sentiment contract. Only entries
 * that went through scoring (or were marked UNVERIFIED-LIVE) appear.
 */
function scoresFromEntries(entries) {
  if (!Array.isArray(entries)) return [];
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || typeof e !== 'object' || !e.sentimentStatus) continue;
    out.push({
      callId: e.callId || e.id || null,
      agentId: e.agentId || null,
      sentiment: e.sentiment == null ? null : Number(e.sentiment),
      leadHotness: e.leadHotness == null ? null : Number(e.leadHotness),
      at: e.endedAt || e.startedAt || null
    });
  }
  return out;
}

function geminiScore(text, apiKey) {
  return new Promise(function (resolve, reject) {
    var prompt = 'Score this customer phone call. Reply with ONLY a JSON ' +
      'object {"sentiment":<number -1 to 1>,"leadHotness":<number 0 to 1>}. ' +
      'sentiment: caller attitude, -1 very negative, 1 very positive. ' +
      'leadHotness: 0 no sales intent, 1 ready to buy/book.\n\nCall:\n' +
      String(text).slice(0, 4000);
    var body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 64 }
    });
    var req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/' + encodeURIComponent(SENTIMENT_MODEL) + ':generateContent?key=' + encodeURIComponent(apiKey),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: MODEL_TIMEOUT_MS
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('model HTTP ' + res.statusCode));
            return;
          }
          var payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          var cand = payload && payload.candidates && payload.candidates[0];
          var part = cand && cand.content && cand.content.parts && cand.content.parts[0];
          var parsed = parseScoreJson(part && part.text);
          if (!parsed) { reject(new Error('unparseable model output')); return; }
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', function () { req.destroy(new Error('model timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Score one call's text. No server key -> unscored, marked UNVERIFIED-LIVE.
 * Model failure -> lexical fallback. Never throws.
 */
function scoreCallText(text, serverKey) {
  if (!serverKey) {
    return Promise.resolve({ sentiment: null, leadHotness: null, status: 'UNVERIFIED-LIVE' });
  }
  return geminiScore(text, serverKey).then(function (parsed) {
    return { sentiment: parsed.sentiment, leadHotness: parsed.leadHotness, status: 'gemini' };
  }).catch(function () {
    var lex = lexicalScore(text);
    return { sentiment: lex.sentiment, leadHotness: lex.leadHotness, status: 'lexical-fallback' };
  });
}

function buildScoringText(entry, summaryText) {
  var parts = [summaryText];
  try {
    if (entry && Array.isArray(entry.notes)) {
      entry.notes.forEach(function (n) { if (n && n.text) parts.push(n.text); });
    }
    if (entry && Array.isArray(entry.transcript)) {
      entry.transcript.slice(-12).forEach(function (t) {
        if (t && t.text) parts.push((t.who || 'x') + ': ' + t.text);
      });
    }
  } catch (e) { /* keep what we have */ }
  return parts.join('\n').slice(0, 6000);
}

/**
 * Score a call whose summary just persisted and save the scores on the
 * memory entry. Fire-and-forget by design: resolves (never rejects) with
 * { sentiment, leadHotness, status }.
 */
function scoreAndSave(store, id, summaryText) {
  return Promise.resolve().then(function () {
    var entry = null;
    try { entry = store.get(id); } catch (e) { entry = null; }
    var text = buildScoringText(entry, summaryText);
    var serverKey = process.env.GEMINI_API_KEY || null;
    return scoreCallText(text, serverKey).then(function (res) {
      return store.setScores(id, res).then(function () { return res; });
    });
  }).catch(function () {
    return { sentiment: null, leadHotness: null, status: 'unscored' };
  });
}

module.exports = {
  lexicalScore: lexicalScore,
  parseScoreJson: parseScoreJson,
  scoresFromEntries: scoresFromEntries,
  scoreCallText: scoreCallText,
  scoreAndSave: scoreAndSave,
  SENTIMENT_MODEL: SENTIMENT_MODEL
};
