'use strict';
/* tests/test-v7-ws6-docs.test.js — WS6 docs page contract.
 * Asserts public/docs.html exists, carries all 10 section anchors, has no
 * placeholder text, every href="#..." anchor resolves to a real id in the
 * file, and the back-link to index.html is present. */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var DOCS = path.join(__dirname, '..', 'public', 'docs.html');
var SECTIONS = [
  'getting-started', 'making-calls', 'agents', 'custom-agents',
  'during-after-calls', 'memory-persistence', 'dashboard-stats',
  'deploying-railway', 'troubleshooting', 'faq'
];

function readDocs() {
  assert.ok(fs.existsSync(DOCS), 'public/docs.html must exist');
  return fs.readFileSync(DOCS, 'utf8');
}

function idsOf(html) {
  var ids = {}, m, re = /id="([^"]+)"/g;
  while ((m = re.exec(html))) ids[m[1]] = true;
  return ids;
}

function hrefAnchors(html) {
  var out = [], m, re = /href="(#[^"]+)"/g;
  while ((m = re.exec(html))) out.push(m[1].slice(1));
  return out;
}

module.exports = {
  'docs.html exists and is a real page': function () {
    var html = readDocs();
    assert.ok(html.indexOf('<!DOCTYPE html>') !== -1, 'must be a full HTML document');
    assert.ok(html.length > 5000, 'must be substantive, got ' + html.length + ' chars');
  },

  'all 10 section anchors exist': function () {
    var html = readDocs(), ids = idsOf(html);
    SECTIONS.forEach(function (s) {
      assert.ok(ids[s], 'missing section id: ' + s);
    });
  },

  'no placeholder text': function () {
    var html = readDocs();
    ['TODO', 'FIXME', 'XXX', 'lorem ipsum', 'lorem', 'PLACEHOLDER'].forEach(function (w) {
      assert.ok(html.toLowerCase().indexOf(w.toLowerCase()) === -1 ||
        // allow the word "lorem" only if... (there is none; strict)
        false, 'placeholder text found: ' + w);
    });
  },

  'every href="#..." anchor resolves to an existing id': function () {
    var html = readDocs(), ids = idsOf(html);
    var anchors = hrefAnchors(html);
    assert.ok(anchors.length > 0, 'expected some in-page anchors');
    anchors.forEach(function (a) {
      assert.ok(ids[a], 'anchor #' + a + ' has no matching id in docs.html');
    });
  },

  'back-link to index.html present': function () {
    var html = readDocs();
    assert.ok(/href="index\.html"/.test(html), 'must link back to index.html');
    assert.ok(/Back to Symbiote Calling|Back to the app/.test(html), 'back link needs visible label');
  },

  'integrator contract comment present': function () {
    var html = readDocs();
    assert.ok(/CONTRACT FOR INTEGRATOR/.test(html), 'top-of-file integrator contract comment required');
    assert.ok(/Docs/.test(html) && /docs\.html/.test(html), 'contract must mention the Docs tab + docs.html');
  },

  'sticky TOC lists all 10 sections': function () {
    var html = readDocs();
    SECTIONS.forEach(function (s) {
      assert.ok(html.indexOf('href="#' + s + '"') !== -1, 'TOC must link to #' + s);
    });
  }
};
