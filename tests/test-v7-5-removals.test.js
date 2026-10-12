'use strict';
/* tests/test-v7-5-removals.test.js — v7.5 fixing release contract.
 *
 * 1. Avatar upload is fully removed from the custom agent builder.
 * 2. Agents page has no gender dropdown and no roles dropdown.
 * 3. History page is gone; recording + transcript downloads live on
 *    Memory entries.
 * 4. Memory detail shows the summary only (no inline transcript/notes).
 * 5. Settings page keeps ONLY "Key profiles" and "Accent colour".
 * 6. Theme audit: v7 UI surfaces follow the app CSS vars.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');

function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

module.exports = {
  // ---------- 1. avatar upload removed ----------
  'custom-agents.js has no cropper and no avatar form field': function () {
    var js = read('public/custom-agents.js');
    assert.ok(js.indexOf('openCropper') === -1, 'cropper function gone');
    assert.ok(js.indexOf('ca-cropper') === -1, 'cropper CSS classes gone');
    assert.ok(js.indexOf('Avatar (optional)') === -1, 'avatar form field gone');
    assert.ok(js.indexOf('dataUrl') === -1, 'no avatar data URLs');
  },
  'custom-agents.js avatarUrlFor is a null stub; merged agents use default avatar': function () {
    var clientCustom = require('../public/custom-agents');
    assert.strictEqual(clientCustom.avatarUrlFor({ id: 'x', isCustom: true }), null);
    var merged = clientCustom.mergeAgentLists([], [{
      id: 'custom_a1', name: 'Zed', role: 'Tester', number: '123', voice: 'Charon'
    }]);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].hasAvatarUpload, false);
    assert.strictEqual(merged[0].avatarUrl, null);
  },
  'custom-agents.css has no cropper styles': function () {
    var css = read('public/custom-agents.css');
    assert.ok(css.indexOf('ca-cropper') === -1, 'cropper styles gone');
    assert.ok(css.indexOf('ca-avatar') === -1, 'avatar styles gone');
  },

  // ---------- 2. agents page dropdowns removed ----------
  'directory.js toolbar has no gender/roles dropdowns': function () {
    var js = read('public/directory.js');
    assert.ok(js.indexOf('All genders') === -1, 'gender dropdown gone');
    assert.ok(js.indexOf('All roles') === -1, 'roles dropdown gone');
    assert.ok(js.indexOf('dir-filter') === -1, 'filter select class gone');
    assert.ok(js.indexOf('Filter by gender') === -1);
    assert.ok(js.indexOf('Filter by role') === -1);
  },
  'directory filterAgents pure logic still supports q search': function () {
    var Directory = require('../public/directory');
    var agents = [
      { id: 'a', name: 'Ava', number: '1', niche: 'Sales', gender: 'female' },
      { id: 'b', name: 'Bob', number: '2', niche: 'Support', gender: 'male' }
    ];
    assert.strictEqual(Directory.filterAgents(agents, { q: 'ava' }).length, 1);
    assert.strictEqual(Directory.filterAgents(agents, { q: '' }).length, 2);
  },

  // ---------- 3. history page removed ----------
  'index.html has no history nav or history view': function () {
    var html = read('public/index.html');
    assert.ok(html.indexOf('data-view="history"') === -1, 'history nav gone');
    assert.ok(html.indexOf('id="view-history"') === -1, 'history view gone');
    assert.ok(html.indexOf('id="historyList"') === -1);
    assert.ok(html.indexOf('id="histDetail"') === -1);
    assert.ok(html.indexOf('id="histFilterAgent"') === -1);
  },
  'app.js has no history page code': function () {
    var js = read('public/app.js');
    assert.ok(js.indexOf('loadHistory') === -1, 'loadHistory gone');
    assert.ok(js.indexOf('openHistoryDetail') === -1, 'openHistoryDetail gone');
    assert.ok(js.indexOf('histFilters') === -1, 'histFilters gone');
    assert.ok(js.indexOf('clearHistory') === -1, 'clearHistory gone');
  },
  'history server API still exists for stats/recents/backup': function () {
    var srv = read('server.js');
    assert.ok(srv.indexOf('/api/history') !== -1, 'history API kept server-side');
  },

  // ---------- 4. memory detail = summary only ----------
  'memory detail renders summary only, no inline transcript or notes': function () {
    var js = read('public/app.js');
    assert.ok(js.indexOf('id="memTranscript"') === -1, 'inline transcript view gone');
    assert.ok(js.indexOf('id="memNotes"') === -1, 'inline notes view gone');
    assert.ok(js.indexOf('id="memSummary"') !== -1, 'summary-only detail present');
  },
  'memory detail keeps transcript + audio download buttons': function () {
    var js = read('public/app.js');
    assert.ok(js.indexOf('id="memDlTranscript"') !== -1, 'transcript download button kept');
    assert.ok(js.indexOf('id="memDlAudio"') !== -1, 'audio download button moved to memory entry');
    assert.ok(js.indexOf('downloadTranscript') !== -1, 'CallX.downloadTranscript wired');
  },

  // ---------- 5. settings page surface ----------
  'settings keeps only key profiles and accent colour': function () {
    var html = read('public/index.html');
    var start = html.indexOf('id="view-settings"');
    assert.ok(start !== -1, 'settings view exists');
    var settings = html.slice(start);
    assert.ok(settings.indexOf('Key profiles') !== -1, 'key profiles kept');
    assert.ok(settings.indexOf('Accent color') !== -1, 'accent colour kept');
    ['id="retentionDays"', 'id="modelInput"', 'id="micDefault"', 'id="themeDefault"',
     'id="diagBox"', 'Data retention', 'Call preferences', '<h3>About</h3>'].forEach(function (gone) {
      assert.ok(settings.indexOf(gone) === -1, 'removed from settings: ' + gone);
    });
  },
  'app.js guards removed settings elements': function () {
    var js = read('public/app.js');
    // direct unguarded access like $('modelInput').value would throw now
    assert.ok(js.indexOf("$('modelInput').value") === -1, 'modelInput access guarded');
    assert.ok(js.indexOf("$('micDefault').checked") === -1, 'micDefault access guarded');
    assert.ok(js.indexOf("$('diagBox').textContent") === -1, 'diagBox access guarded');
  },

  // ---------- 6. theme audit ----------
  'custom-agents.css uses theme vars, no hardcoded light surfaces': function () {
    var css = read('public/custom-agents.css');
    var offenders = ['#1e2433', '#6b7280', '#9ca3af', '#d1d5db', '#e5e7eb',
      '#f9fafb', '#ede9fe', '#f5f3ff', '#fef2f2', '#fecaca', '#b91c1c',
      '#dc2626', '#f3f4f6'];
    offenders.forEach(function (c) {
      assert.ok(css.indexOf(c) === -1, 'hardcoded color remains: ' + c);
    });
    ['var(--panel)', 'var(--ink)', 'var(--muted)', 'var(--line', 'var(--acc)'].forEach(function (v) {
      assert.ok(css.indexOf(v) !== -1, 'theme var used: ' + v);
    });
  },
  'custom-agents.css no longer overrides the app accent': function () {
    var css = read('public/custom-agents.css');
    assert.ok(css.indexOf('--accent:') === -1, 'app --acc drives the accent now');
    assert.ok(css.indexOf('var(--acc)') !== -1, '--acc used');
  },
  'directory.css / keygate.css / callx.css are theme-var driven': function () {
    var dir = read('public/directory.css');
    assert.ok(dir.indexOf('var(--panel)') !== -1 && dir.indexOf('var(--ink)') !== -1);
    var kg = read('public/keygate.css');
    assert.ok(kg.indexOf('var(--kg-card)') !== -1);
    var cx = read('public/callx.css');
    assert.ok(cx.indexOf('var(--panel)') !== -1);
  }
};
