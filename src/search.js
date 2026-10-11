'use strict';
/**
 * src/search.js — bounded, no-key web search for the web_search tool.
 *
 * Clean-room implementation. Provider chain (first non-empty wins):
 *   1. DuckDuckGo instant-answer API — quick facts, definitions.
 *   2. Wikipedia opensearch API — reliable factual results, no key.
 *   3. Google News RSS — real-time news, no key (follows redirects).
 *   4. DuckDuckGo lite HTML — general web results fallback.
 * Per-provider timeout (10s) and per-provider circuit breakers, so one
 * slow/blocked provider can never take the whole chain down. If every
 * provider fails, report "search unavailable" — never invent results.
 */

var https = require('https');

var TIMEOUT_MS = 10000;
var BREAKER_THRESHOLD = 3;
var BREAKER_COOLDOWN_MS = 2 * 60 * 1000;
var MAX_RESULTS = 5;
var MAX_REDIRECTS = 2;

var providers = [
  { name: 'ddg-instant', failures: 0, openUntil: 0 },
  { name: 'wikipedia', failures: 0, openUntil: 0 },
  { name: 'gnews', failures: 0, openUntil: 0 },
  { name: 'ddg-lite', failures: 0, openUntil: 0 }
];

function breakerOpen(p) { return Date.now() < p.openUntil; }
function recordFailure(p) {
  p.failures++;
  if (p.failures >= BREAKER_THRESHOLD) p.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
}
function recordSuccess(p) { p.failures = 0; p.openUntil = 0; }

function fetchUrl(url, wantText, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    var req = https.get(url, { headers: { 'User-Agent': 'symbiote-calling/3.0 (local demo)' } }, function (res) {
      // Follow redirects (Google News RSS 302s).
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
        var next = res.headers.location;
        if (next.indexOf('http') !== 0) {
          try { next = new URL(next, url).toString(); } catch (e) { reject(new Error('bad redirect')); return; }
        }
        res.resume();
        fetchUrl(next, wantText, redirects + 1).then(resolve, reject);
        return;
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error('HTTP ' + res.statusCode)); return; }
        if (wantText) { resolve(body); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
  });
}

var defaultFetch = {
  json: function (url) { return fetchUrl(url, false); },
  text: function (url) { return fetchUrl(url, true); }
};

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function unescapeHtml(s) {
  return clean(s).replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function stripCdata(s) { return String(s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, ''); }

function ddgInstant(data) {
  var results = [];
  (data.RelatedTopics || []).forEach(function (t) {
    if (results.length >= MAX_RESULTS) return;
    if (t.Text && t.FirstURL) {
      results.push({ title: clean(t.Text).slice(0, 120), url: t.FirstURL, snippet: clean(t.Text).slice(0, 300) });
    } else if (t.Topics) {
      t.Topics.forEach(function (s) {
        if (s.Text && s.FirstURL && results.length < MAX_RESULTS) {
          results.push({ title: clean(s.Text).slice(0, 120), url: s.FirstURL, snippet: clean(s.Text).slice(0, 300) });
        }
      });
    }
  });
  if (data.AbstractText && data.AbstractURL && results.length < MAX_RESULTS) {
    results.unshift({ title: clean(data.Heading || 'Summary').slice(0, 120), url: data.AbstractURL, snippet: clean(data.AbstractText).slice(0, 300) });
  }
  return results;
}

function wikiOpensearch(data) {
  var results = [];
  var titles = data[1] || [], descs = data[2] || [], urls = data[3] || [];
  for (var i = 0; i < titles.length && results.length < MAX_RESULTS; i++) {
    if (titles[i] && urls[i]) {
      results.push({ title: clean(titles[i]).slice(0, 120), url: urls[i], snippet: clean(descs[i]).slice(0, 300) || 'Wikipedia article' });
    }
  }
  return results;
}

function gnewsRss(xml) {
  var results = [];
  var items = String(xml).match(/<item>([\s\S]*?)<\/item>/g) || [];
  for (var i = 0; i < items.length && results.length < MAX_RESULTS; i++) {
    var it = items[i];
    var titleM = it.match(/<title>([\s\S]*?)<\/title>/);
    var linkM = it.match(/<link>([\s\S]*?)<\/link>/);
    var dateM = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!titleM || !linkM) continue;
    var title = unescapeHtml(stripCdata(titleM[1]));
    title = title.replace(/\s+-\s+[^-]+$/, ''); // strip " - Source" suffix
    var link = stripCdata(linkM[1]).trim();
    if (!/^https?:\/\//.test(link)) continue;
    results.push({
      title: title.slice(0, 140),
      url: link,
      snippet: (dateM ? clean(stripCdata(dateM[1])).slice(0, 60) + ' — Google News' : 'Google News')
    });
  }
  return results;
}

function ddgLite(html) {
  var results = [];
  var re = /<a[^>]*rel="nofollow"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]{4,140})<\/a>/gi;
  var m;
  while ((m = re.exec(html)) && results.length < MAX_RESULTS) {
    var url = m[1], title = unescapeHtml(m[2]);
    if (/duckduckgo\.com/.test(url)) continue;
    if (results.some(function (r) { return r.url === url; })) continue;
    results.push({ title: title, url: url, snippet: '' });
  }
  return results;
}

/**
 * webSearch(query, fetchImpl?) -> { results:[{title,url,snippet}] }
 *   or { unavailable:true, reason }. Never throws for provider issues.
 */
async function webSearch(query, fetchImpl) {
  var f = fetchImpl || defaultFetch;
  if (!query || !String(query).trim()) return { unavailable: true, reason: 'empty query' };
  var q = String(query).trim();
  var fns = [
    function () { return f.json('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1&skip_disambig=1').then(ddgInstant); },
    function () { return f.json('https://en.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(q) + '&limit=5&format=json').then(wikiOpensearch); },
    function () { return f.text('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en&gl=US&ceid=US:en').then(gnewsRss); },
    function () { return f.text('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q)).then(ddgLite); }
  ];
  for (var i = 0; i < fns.length; i++) {
    var p = providers[i];
    if (breakerOpen(p)) continue;
    try {
      var results = await fns[i]();
      if (results && results.length) { recordSuccess(p); return { results: results }; }
      // Empty is not a failure — just try the next provider.
    } catch (e) { recordFailure(p); }
  }
  return { unavailable: true, reason: 'no results (tried all providers)' };
}

function breakerState() {
  return providers.map(function (p) { return { name: p.name, open: breakerOpen(p), failures: p.failures }; });
}
function _resetBreaker() { providers.forEach(function (p) { p.failures = 0; p.openUntil = 0; }); }

module.exports = { webSearch: webSearch, breakerState: breakerState, _resetBreaker: _resetBreaker, TIMEOUT_MS: TIMEOUT_MS };
