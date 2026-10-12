'use strict';
/* tests/summary.test.js — client-side auto call summaries. */
var assert = require('assert');
var summary = require('../public/summary.js');

function withFetch(stub, fn) {
  var orig = global.fetch;
  global.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .then(function (v) { global.fetch = orig; return v; }, function (e) { global.fetch = orig; throw e; });
}

function bigTranscript(n, size) {
  var t = [];
  for (var i = 0; i < n; i++) {
    var text = '';
    while (text.length < size) text += 'lorem ipsum dolor sit amet ';
    t.push({ who: i % 2 ? 'agent' : 'user', text: text });
  }
  return t;
}

module.exports = {
  'SUMMARY_MODEL is the cheap model id': async function () {
    assert.strictEqual(summary.SUMMARY_MODEL, 'gemini-3.1-flash-live-preview');
  },

  'buildPrompt includes caller/agent lines and asks for summary + Outcome:': async function () {
    var p = summary.buildPrompt([
      { who: 'user', text: 'I need a dentist appointment' },
      { who: 'agent', text: 'Booked for Oct 15 at 3pm' }
    ]);
    assert.ok(p.indexOf('Caller: I need a dentist appointment') !== -1, 'caller line');
    assert.ok(p.indexOf('Agent: Booked for Oct 15 at 3pm') !== -1, 'agent line');
    assert.ok(/summar/i.test(p), 'asks for a summary');
    assert.ok(p.indexOf('Outcome:') !== -1, 'asks for Outcome: line');
    assert.ok(/no markdown/i.test(p), 'plain-text only');
  },

  'buildPrompt caps long transcripts (drops oldest first)': async function () {
    var t = bigTranscript(50, 500); // ~25k chars total
    t[0] = { who: 'user', text: 'FIRST_LINE_UNIQUE_MARKER' };
    t[t.length - 1] = { who: 'agent', text: 'LAST_LINE_UNIQUE_MARKER' };
    var p = summary.buildPrompt(t);
    assert.ok(p.indexOf('LAST_LINE_UNIQUE_MARKER') !== -1, 'newest line kept');
    assert.ok(p.indexOf('FIRST_LINE_UNIQUE_MARKER') === -1, 'oldest line dropped');
    assert.ok(p.length < 6000 + 1200, 'prompt length bounded, got ' + p.length);
  },

  'summarize resolves null when apiKey missing WITHOUT calling fetch': async function () {
    var called = 0;
    await withFetch(function () { called++; return Promise.reject(new Error('nope')); }, async function () {
      var r1 = await summary.summarize(null, [{ who: 'user', text: 'hi' }]);
      var r2 = await summary.summarize('', [{ who: 'user', text: 'hi' }]);
      var r3 = await summary.summarize(undefined, [{ who: 'user', text: 'hi' }]);
      assert.strictEqual(r1, null);
      assert.strictEqual(r2, null);
      assert.strictEqual(r3, null);
      assert.strictEqual(called, 0, 'fetch must not be called without a key');
    });
  },

  'summarize resolves null when transcript empty or invalid (fetch not called)': async function () {
    var called = 0;
    await withFetch(function () { called++; return Promise.reject(new Error('nope')); }, async function () {
      assert.strictEqual(await summary.summarize('KEY', []), null);
      assert.strictEqual(await summary.summarize('KEY', null), null);
      assert.strictEqual(await summary.summarize('KEY', 'not-an-array'), null);
      assert.strictEqual(called, 0, 'fetch must not be called for bad transcript');
    });
  },

  'summarize sends x-goog-api-key header, never the key in the URL': async function () {
    var seen;
    await withFetch(function (url, opts) {
      seen = { url: url, opts: opts };
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }); } });
    }, async function () {
      var r = await summary.summarize('SECRET-KEY', [{ who: 'user', text: 'hi' }]);
      assert.strictEqual(r, 'done');
      assert.strictEqual(seen.opts.headers['x-goog-api-key'], 'SECRET-KEY');
      assert.ok(seen.url.indexOf('SECRET-KEY') === -1, 'key must not appear in URL');
      var parsed = JSON.parse(seen.opts.body);
      assert.strictEqual(parsed.generationConfig.maxOutputTokens, 300);
      assert.ok(parsed.contents[0].parts[0].text.indexOf('Caller: hi') !== -1);
    });
  },

  'summarize resolves null when fetch rejects': async function () {
    await withFetch(function () { return Promise.reject(new Error('network down')); }, async function () {
      assert.strictEqual(await summary.summarize('KEY', [{ who: 'user', text: 'hi' }]), null);
    });
  },

  'summarize resolves null on non-ok response': async function () {
    await withFetch(function () { return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({}); } }); }, async function () {
      assert.strictEqual(await summary.summarize('KEY', [{ who: 'user', text: 'hi' }]), null);
    });
  },

  'summarize resolves null on bad payload shapes': async function () {
    var shapes = [{}, { candidates: [] }, { candidates: [{}] }, { candidates: [{ content: {} }] },
      { candidates: [{ content: { parts: [] } }] }, { candidates: [{ content: { parts: [{ text: '   ' }] } }] }];
    for (var i = 0; i < shapes.length; i++) {
      var shape = shapes[i];
      await withFetch(function () { return Promise.resolve({ ok: true, json: function () { return Promise.resolve(shape); } }); }, async function () {
        assert.strictEqual(await summary.summarize('KEY', [{ who: 'user', text: 'hi' }]), null, 'shape ' + i);
      });
    }
  },

  'summarize returns joined trimmed text on stubbed success shape': async function () {
    await withFetch(function () {
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({ candidates: [{ content: { parts: [{ text: 'hi' }, { text: 'there' }] } }] });
        }
      });
    }, async function () {
      assert.strictEqual(await summary.summarize('KEY', [{ who: 'user', text: 'hi' }]), 'hithere');
    });
  },

  'summarize caps summary at 2000 chars': async function () {
    var long = '';
    while (long.length < 3000) long += 'x';
    await withFetch(function () {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ candidates: [{ content: { parts: [{ text: long }] } }] }); } });
    }, async function () {
      var r = await summary.summarize('KEY', [{ who: 'user', text: 'hi' }]);
      assert.strictEqual(r.length, 2000);
    });
  },

  'summarize never rejects, even with fetch throwing synchronously': async function () {
    await withFetch(function () { throw new Error('sync boom'); }, async function () {
      assert.strictEqual(await summary.summarize('KEY', [{ who: 'user', text: 'hi' }]), null);
    });
  },

  'browser-global path: window.CallSummary exposes the API': async function () {
    // Simulate a browser-ish sandbox: no module/exports, with a global root.
    var fs = require('fs');
    var code = fs.readFileSync(__dirname + '/../public/summary.js', 'utf8');
    var vm = require('vm');
    var sandbox = { self: {} };
    sandbox.window = sandbox.self;
    vm.createContext(sandbox);
    vm.runInContext(code + '\nthis.__probe = typeof CallSummary;', sandbox);
    assert.ok(sandbox.self.CallSummary, 'root.CallSummary set');
    assert.strictEqual(sandbox.self.CallSummary.SUMMARY_MODEL, 'gemini-3.1-flash-live-preview');
    assert.strictEqual(typeof sandbox.self.CallSummary.buildPrompt, 'function');
    assert.strictEqual(typeof sandbox.self.CallSummary.summarize, 'function');
  }
};
