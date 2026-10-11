'use strict';
/* tests/search.test.js — provider chain with stubbed fetch (no network). */
var assert = require('assert');
var search = require('../src/search');

function stubFetch(handlers) {
  return {
    json: function (url) {
      for (var k in handlers) { if (url.indexOf(k) !== -1 && handlers[k].json) return Promise.resolve(handlers[k].json()); }
      return Promise.reject(new Error('no stub for ' + url));
    },
    text: function (url) {
      for (var k in handlers) { if (url.indexOf(k) !== -1 && handlers[k].text) return Promise.resolve(handlers[k].text()); }
      return Promise.reject(new Error('no stub for ' + url));
    }
  };
}

module.exports = {
  'ddg instant answer hit wins': async function () {
    search._resetBreaker();
    var f = stubFetch({
      'api.duckduckgo.com': { json: function () { return { AbstractText: 'Paris is the capital of France.', AbstractURL: 'https://en.wikipedia.org/wiki/Paris', Heading: 'Paris', RelatedTopics: [] }; } }
    });
    var r = await search.webSearch('capital of france', f);
    assert.ok(!r.unavailable);
    assert.strictEqual(r.results.length, 1);
    assert.ok(r.results[0].snippet.indexOf('Paris') !== -1);
  },
  'empty ddg falls through to wikipedia': async function () {
    search._resetBreaker();
    var f = stubFetch({
      'api.duckduckgo.com': { json: function () { return { RelatedTopics: [] }; } },
      'wikipedia.org': { json: function () { return ['q', ['Lahore'], ['City in Pakistan'], ['https://en.wikipedia.org/wiki/Lahore']]; } }
    });
    var r = await search.webSearch('lahore', f);
    assert.ok(!r.unavailable);
    assert.strictEqual(r.results[0].title, 'Lahore');
  },
  'news query falls through to google news rss': async function () {
    search._resetBreaker();
    var f = stubFetch({
      'api.duckduckgo.com': { json: function () { return { RelatedTopics: [] }; } },
      'wikipedia.org': { json: function () { return ['q', [], [], []]; } },
      'news.google.com': { text: function () {
        return '<rss><channel><item><title><![CDATA[Big match today - Dawn]]></title><link>https://example.com/match</link><pubDate>Sun, 11 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>';
      } }
    });
    var r = await search.webSearch('cricket match today', f);
    assert.ok(!r.unavailable);
    assert.strictEqual(r.results[0].title, 'Big match today');
    assert.strictEqual(r.results[0].url, 'https://example.com/match');
  },
  'open breaker skips that provider, others still work': async function () {
    search._resetBreaker();
    var fail = stubFetch({}); // everything errors
    for (var i = 0; i < 3; i++) await search.webSearch('x', fail);
    var st = search.breakerState();
    assert.ok(st.every(function (p) { return p.open; }), 'all providers tripped after 3 failures');
    // reset one provider path: wikipedia healthy again
    search._resetBreaker();
    var f = stubFetch({
      'api.duckduckgo.com': { json: function () { return Promise.reject(new Error('down')); } },
      'wikipedia.org': { json: function () { return ['q', ['Lahore'], ['d'], ['https://en.wikipedia.org/wiki/Lahore']]; } }
    });
    var r = await search.webSearch('lahore', f);
    assert.ok(!r.unavailable, 'chain survives a dead provider');
  },
  'all providers fail -> unavailable, never throws': async function () {
    search._resetBreaker();
    var r = await search.webSearch('anything', stubFetch({}));
    assert.ok(r.unavailable);
    assert.ok(r.reason);
  },
  'empty query -> unavailable without touching providers': async function () {
    search._resetBreaker();
    var calls = 0;
    var f = { json: function () { calls++; return Promise.reject(new Error('x')); }, text: function () { calls++; return Promise.reject(new Error('x')); } };
    var r = await search.webSearch('   ', f);
    assert.ok(r.unavailable);
    assert.strictEqual(calls, 0);
  }
};
