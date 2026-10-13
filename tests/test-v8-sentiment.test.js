'use strict';
/* tests/test-v8-sentiment.test.js -- v8 #11 sentiment + lead scoring
 * (src/sentiment.js) pure helpers + MemoryStore hook behavior.
 * The Gemini path is NOT hit: with no server key the call is marked
 * UNVERIFIED-LIVE and left unscored. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var sentiment = require('../src/sentiment');
var MemoryStore = require('../src/memory').MemoryStore;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'v8sent-'));
}

module.exports = {
  'lexicalScore: positive text -> positive sentiment': async function () {
    var r = sentiment.lexicalScore('The caller loved the demo, absolutely amazing and perfect.');
    assert.ok(r.sentiment > 0, 'positive, got ' + r.sentiment);
    assert.ok(r.sentiment <= 1);
    assert.ok(r.leadHotness >= 0 && r.leadHotness <= 1);
  },

  'lexicalScore: negative text -> negative sentiment': async function () {
    var r = sentiment.lexicalScore('Terrible service, angry and frustrated, worst experience, cancel now.');
    assert.ok(r.sentiment < 0, 'negative, got ' + r.sentiment);
    assert.ok(r.sentiment >= -1);
  },

  'lexicalScore: neutral text -> zero sentiment': async function () {
    var r = sentiment.lexicalScore('The caller asked about opening hours and said ok.');
    assert.strictEqual(r.sentiment, 0);
    assert.strictEqual(r.leadHotness, 0);
  },

  'lexicalScore: buying intent -> hot lead': async function () {
    var r = sentiment.lexicalScore('I want to buy this, what is the price? Can you send me a quote?');
    assert.ok(r.leadHotness > 0.5, 'hot lead, got ' + r.leadHotness);
    assert.ok(r.leadHotness <= 1);
  },

  'lexicalScore: never throws, always clamped': async function () {
    var r = sentiment.lexicalScore(null);
    assert.strictEqual(r.sentiment, 0);
    assert.strictEqual(r.leadHotness, 0);
    var r2 = sentiment.lexicalScore('love '.repeat(500) + 'hate '.repeat(500));
    assert.ok(r2.sentiment >= -1 && r2.sentiment <= 1);
  },

  'parseScoreJson: valid model output': async function () {
    var r = sentiment.parseScoreJson('{"sentiment":0.4,"leadHotness":0.8}');
    assert.deepStrictEqual(r, { sentiment: 0.4, leadHotness: 0.8 });
  },

  'parseScoreJson: clamps out-of-range values': async function () {
    var r = sentiment.parseScoreJson('Sure! {"sentiment":5,"leadHotness":-2} done');
    assert.deepStrictEqual(r, { sentiment: 1, leadHotness: 0 });
  },

  'parseScoreJson: garbage -> null': async function () {
    assert.strictEqual(sentiment.parseScoreJson('no json here'), null);
    assert.strictEqual(sentiment.parseScoreJson('{"sentiment":"high"}'), null);
    assert.strictEqual(sentiment.parseScoreJson(null), null);
    assert.strictEqual(sentiment.parseScoreJson('{}'), null);
  },

  'scoresFromEntries: contract shape, skips unscored entries': async function () {
    var out = sentiment.scoresFromEntries([
      { id: 'mem_1', callId: 'call_9', agentId: 'ava', sentiment: 0.5, leadHotness: 0.9,
        sentimentStatus: 'gemini', endedAt: '2026-10-13T10:00:00Z' },
      { id: 'mem_2', agentId: 'liam', sentiment: null, leadHotness: null,
        sentimentStatus: 'UNVERIFIED-LIVE', startedAt: '2026-10-13T11:00:00Z' },
      { id: 'mem_3', agentId: 'liam' } // never scored -> skipped
    ]);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], {
      callId: 'call_9', agentId: 'ava', sentiment: 0.5, leadHotness: 0.9,
      at: '2026-10-13T10:00:00Z'
    });
    assert.deepStrictEqual(out[1], {
      callId: 'mem_2', agentId: 'liam', sentiment: null, leadHotness: null,
      at: '2026-10-13T11:00:00Z'
    });
  },

  'scoresFromEntries: non-array -> []': async function () {
    assert.deepStrictEqual(sentiment.scoresFromEntries(null), []);
  },

  'scoreCallText: no server key -> UNVERIFIED-LIVE, unscored': async function () {
    var r = await sentiment.scoreCallText('caller loved it, wants to buy', null);
    assert.deepStrictEqual(r, { sentiment: null, leadHotness: null, status: 'UNVERIFIED-LIVE' });
  },

  'setSummary fires scoring and marks entry UNVERIFIED-LIVE without a server key': async function () {
    var savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      var dir = tmpDir();
      var m = new MemoryStore(dir, null);
      var id = await m.beginCall({ keyHash: 'k', agentId: 'ava', agentName: 'Ava', number: '1' });
      await m.addNote(id, 'caller wants to buy the premium plan');
      await m.setSummary(id, 'Caller liked the demo and asked about pricing.');
      // scoring is fire-and-forget; allow it a tick to land
      await new Promise(function (r) { setTimeout(r, 50); });
      var entry = m.get(id);
      assert.strictEqual(entry.sentimentStatus, 'UNVERIFIED-LIVE');
      assert.strictEqual(entry.sentiment, null);
      assert.strictEqual(entry.leadHotness, null);
      assert.ok(entry.scoredAt, 'scoredAt timestamp set');
      // list() exposes the score fields (summary view)
      var listed = m.list()[0];
      assert.strictEqual(listed.sentimentStatus, 'UNVERIFIED-LIVE');
      assert.strictEqual(listed.sentiment, null);
      // listScores() covers it for GET /api/v8/sentiment
      var scores = m.listScores();
      assert.strictEqual(scores.length, 1);
      assert.strictEqual(scores[0].callId, id);
      assert.strictEqual(scores[0].agentId, 'ava');
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    }
  },

  'scoreAndSave never rejects, even for unknown ids': async function () {
    var savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      var dir = tmpDir();
      var m = new MemoryStore(dir, null);
      var r = await sentiment.scoreAndSave(m, 'mem_missing', 'some summary');
      assert.strictEqual(r.status, 'UNVERIFIED-LIVE');
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    }
  }
};
