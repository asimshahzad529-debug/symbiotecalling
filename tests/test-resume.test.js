'use strict';
/* tests/test-resume.test.js — background call survival (mobile):
 * the caller minimizes Chrome (e.g. opens the Play Store) and the client
 * reconnects with a resumeNote. The server must skip the greeting trigger,
 * feed the resume note as context, and flag setup_complete as resumed. */
var assert = require('assert');
var live = require('../src/live');

function fakeSdk(capture) {
  function GoogleGenAI() {}
  GoogleGenAI.prototype.live = {
    connect: function (opts) {
      capture.callbacks = opts.callbacks;
      var session = {
        sendClientContent: function (req) { capture.sent.push(req); },
        sendRealtimeInput: function () {},
        sendToolResponse: function () {},
        close: function () {}
      };
      return Promise.resolve(session);
    }
  };
  return { GoogleGenAI: GoogleGenAI, Modality: { AUDIO: 'A' }, Type: {} };
}

async function driveSetupComplete(opts) {
  var capture = { callbacks: null, sent: [], events: [] };
  var demoKey = 'demo';
  var sess = live.createOmniSession(Object.assign({
    sdk: fakeSdk(capture),
    apiKey: demoKey,
    models: ['test-model'],
    onEvent: function (ev) { capture.events.push(ev); }
  }, opts || {}));
  await sess.start();
  assert.ok(capture.callbacks, 'sdk connect captured callbacks');
  capture.callbacks.onmessage({ setupComplete: true });
  sess.hangup();
  return capture;
}

function sentTexts(capture) {
  return capture.sent.map(function (r) {
    try { return r.turns[0].parts[0].text; } catch (e) { return ''; }
  });
}

module.exports = {
  'resume: setup_complete flagged resumed, note fed, no greeting trigger': async function () {
    var note = '[System note: the caller briefly switched apps and is back.]';
    var c = await driveSetupComplete({ resumeNote: note });
    var setupEv = c.events.filter(function (e) { return e.type === 'setup_complete'; });
    assert.strictEqual(setupEv.length, 1, 'exactly one setup_complete');
    assert.strictEqual(setupEv[0].resumed, true, 'resumed flag set');
    var texts = sentTexts(c);
    assert.ok(texts.some(function (t) { return t.indexOf('[System note:') === 0; }), 'resume note sent as context');
    assert.ok(!texts.some(function (t) { return /greet the caller/i.test(t); }), 'no greeting trigger sent');
    var gs = c.events.filter(function (e) { return e.type === 'greeting_state'; });
    assert.ok(gs.some(function (e) { return e.state === 'resumed'; }), 'greeting_state resumed emitted');
  },

  'fresh call (no resumeNote): greeting trigger still sent, resumed false': async function () {
    var c = await driveSetupComplete({});
    var setupEv = c.events.filter(function (e) { return e.type === 'setup_complete'; });
    assert.strictEqual(setupEv.length, 1, 'exactly one setup_complete');
    assert.strictEqual(setupEv[0].resumed, false, 'resumed flag false on fresh call');
    var texts = sentTexts(c);
    assert.ok(texts.some(function (t) { return /greet the caller/i.test(t); }), 'greeting trigger sent on fresh call');
  },

  'resume: model reply to the note does not retrigger greeting timers': async function () {
    var c = await driveSetupComplete({ resumeNote: '[System note: back.]' });
    // Model answers the resume note with audio -> must not emit trigger_sent/retry.
    c.callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA', mimeType: 'audio/pcm;rate=24000' } }] } } });
    var gs = c.events.filter(function (e) { return e.type === 'greeting_state'; }).map(function (e) { return e.state; });
    assert.ok(gs.indexOf('trigger_sent') === -1, 'no trigger_sent after resume, got: ' + gs.join(','));
    assert.ok(gs.indexOf('retry_sent') === -1, 'no retry_sent after resume');
  }
};
