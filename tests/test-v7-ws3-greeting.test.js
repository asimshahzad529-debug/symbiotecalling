'use strict';
/* tests/test-v7-ws3-greeting.test.js — WS3 (v7): robust greeting handshake.
 *
 * Drives src/live.js with a mock session ({sendClientContent: fn}) and a
 * fake SDK. Timers are real but shortened via opts (greetingNudgeMs /
 * greetingFailMs). No network, no API key.
 */
var assert = require('assert');
var live = require('../src/live');

global.window = global.window || {};

function tick(n) {
  return new Promise(function (res) {
    var i = 0;
    (function next() { if (++i >= (n || 4)) res(); else setImmediate(next); })();
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function fakeSdk() {
  var sessions = [];
  function FakeGenAI(opts) { this.apiKey = opts.apiKey; }
  FakeGenAI.prototype.live = {
    connect: async function (params) {
      var sess = {
        callbacks: params.callbacks,
        clientContents: [],
        closed: false,
        sendClientContent: function (p) { this.clientContents.push(p); },
        sendRealtimeInput: function () {},
        sendToolResponse: function () {},
        close: function () { this.closed = true; }
      };
      sessions.push(sess);
      return sess;
    }
  };
  return {
    Modality: { AUDIO: 'AUDIO' },
    Type: { OBJECT: 'OBJECT', STRING: 'STRING' },
    GoogleGenAI: FakeGenAI,
    _sessions: sessions
  };
}

// Start a live session against the fake SDK and confirm setup.
async function started(opts) {
  var sdk = fakeSdk();
  var events = [];
  var s = live.createOmniSession(Object.assign({
    apiKey: 'DUMMY', models: ['fake-model'], agentName: 'Ava', agentId: 'ava',
    systemInstruction: 'test instruction', // bridge always supplies this; bypasses prompt module
    sdk: sdk, onEvent: function (ev) { events.push(ev); }
  }, opts || {}));
  await s.start();
  await tick();
  var mock = sdk._sessions[0];
  mock.callbacks.onmessage({ setupComplete: {} });
  await tick();
  return { session: s, mock: mock, events: events };
}

function greetStates(events) {
  return events.filter(function (e) { return e.type === 'greeting_state'; })
               .map(function (e) { return e.state; });
}

function turnText(content) {
  return content.turns[0].parts[0].text;
}

module.exports = {
  'trigger sent exactly once on setupComplete with direct phrasing': async function () {
    var t = await started({ greetingNudgeMs: 50, greetingFailMs: 500 });
    assert.strictEqual(t.mock.clientContents.length, 1, 'exactly one trigger turn');
    var text = turnText(t.mock.clientContents[0]);
    assert.strictEqual(text, 'Greet the caller now with a brief hello as Ava.');
    assert.ok(text.charAt(0) !== '[', 'no bracketed meta-instruction');
    assert.deepStrictEqual(greetStates(t.events), ['trigger_sent']);
    var ev = t.events.filter(function (e) { return e.type === 'greeting_state'; })[0];
    assert.deepStrictEqual(ev.detail, { attempt: 1 });
    await t.session.hangup();
  },

  'retry fired once after silence, then failed': async function () {
    var t = await started({ greetingNudgeMs: 30, greetingFailMs: 100 });
    assert.strictEqual(t.mock.clientContents.length, 1);
    await sleep(70);
    assert.strictEqual(t.mock.clientContents.length, 2, 'one retry after silence');
    var retryText = turnText(t.mock.clientContents[1]);
    assert.ok(retryText !== turnText(t.mock.clientContents[0]), 'variant phrasing');
    assert.ok(/greeting/i.test(retryText), 'retry mentions greeting');
    assert.deepStrictEqual(greetStates(t.events), ['trigger_sent', 'retry_sent']);
    await sleep(120); // past the fail budget
    assert.strictEqual(t.mock.clientContents.length, 2, 'nothing more sent after retry');
    var states = greetStates(t.events);
    assert.strictEqual(states[states.length - 1], 'failed', 'failed state emitted');
    var failed = t.events.filter(function (e) { return e.type === 'greeting_failed'; });
    assert.strictEqual(failed.length, 1, 'greeting_failed emitted once');
    assert.strictEqual(failed[0].hint, 'Say hello to begin');
    await t.session.hangup();
  },

  'no retry after audio output; audio_received emitted': async function () {
    var t = await started({ greetingNudgeMs: 40, greetingFailMs: 120 });
    t.mock.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm;rate=24000' } }] } }
    });
    await tick();
    var gs = t.events.filter(function (e) { return e.type === 'greeting_state'; });
    assert.deepStrictEqual(gs.map(function (e) { return e.state; }), ['trigger_sent', 'audio_received']);
    assert.strictEqual(gs[1].detail.outputKind, 'audio');
    assert.ok(typeof gs[1].detail.latencyMs === 'number', 'latency recorded');
    await sleep(220); // past retry + fail budgets
    assert.strictEqual(t.mock.clientContents.length, 1, 'no retry after audio');
    assert.ok(greetStates(t.events).indexOf('failed') === -1, 'no failure after output');
    assert.ok(!t.events.some(function (e) { return e.type === 'greeting_failed'; }));
    await t.session.hangup();
  },

  'text-only output resolves as degraded success': async function () {
    var t = await started({ greetingNudgeMs: 40, greetingFailMs: 120 });
    t.mock.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ text: 'Hello! This is Ava.' }] } }
    });
    await tick();
    var gs = t.events.filter(function (e) { return e.type === 'greeting_state'; });
    assert.strictEqual(gs[1].state, 'text_received');
    assert.strictEqual(gs[1].detail.outputKind, 'text');
    assert.ok(gs[1].detail.text.indexOf('Hello!') !== -1);
    var to = t.events.filter(function (e) { return e.type === 'greeting_text_only'; });
    assert.strictEqual(to.length, 1, 'greeting_text_only emitted once');
    assert.ok(to[0].text.indexOf('Hello!') !== -1, 'text carried for transcript bubble');
    await sleep(220);
    assert.strictEqual(t.mock.clientContents.length, 1, 'timers cleared on text output');
    await t.session.hangup();
  },

  'second setupComplete (resume) sends no trigger': async function () {
    var t = await started({ greetingNudgeMs: 30, greetingFailMs: 100 });
    t.mock.callbacks.onmessage({ setupComplete: {} }); // resumed session re-confirms
    await tick();
    await sleep(200); // past retry + fail
    assert.strictEqual(t.mock.clientContents.length, 2, 'trigger + one retry only; resume adds nothing');
    assert.strictEqual(greetStates(t.events).filter(function (s) { return s === 'trigger_sent'; }).length, 1);
    await t.session.hangup();
  },

  'toolCall counts as model output and resolves the handshake': async function () {
    var t = await started({ greetingNudgeMs: 40, greetingFailMs: 120 });
    t.mock.callbacks.onmessage({ toolCall: { functionCalls: [{ name: 'get_datetime', id: '1', args: {} }] } });
    await tick();
    var gs = t.events.filter(function (e) { return e.type === 'greeting_state'; });
    assert.strictEqual(gs[1].state, 'text_received', 'tool output resolves handshake');
    await sleep(220);
    assert.strictEqual(t.mock.clientContents.length, 1, 'no retry after tool output');
    await t.session.hangup();
  },

  'greetingTriggerText is a direct instruction': function () {
    assert.strictEqual(live.greetingTriggerText('Lina'), 'Greet the caller now with a brief hello as Lina.');
  },

  'greetingRetryText is a variant of the trigger': function () {
    var a = live.greetingTriggerText('Lina'), b = live.greetingRetryText('Lina');
    assert.ok(b && b !== a, 'different phrasing');
    assert.ok(/greeting/i.test(b), 'retry mentions greeting');
  },

  'greetingClassifyOutput distinguishes output kinds': function () {
    assert.strictEqual(live.greetingClassifyOutput(null), null);
    assert.strictEqual(live.greetingClassifyOutput({}), null);
    assert.strictEqual(live.greetingClassifyOutput({ serverContent: {} }), null);
    var audio = live.greetingClassifyOutput({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] } }
    });
    assert.strictEqual(audio.kind, 'audio');
    var mixed = live.greetingClassifyOutput({
      serverContent: { modelTurn: { parts: [{ text: 'hi' }, { inlineData: { data: 'AAA=' } }] } }
    });
    assert.strictEqual(mixed.kind, 'audio', 'audio wins in mixed parts');
    var text = live.greetingClassifyOutput({
      serverContent: { modelTurn: { parts: [{ text: 'hi there' }] } }
    });
    assert.strictEqual(text.kind, 'text');
    assert.strictEqual(text.text, 'hi there');
    var trans = live.greetingClassifyOutput({
      serverContent: { outputTranscription: { text: 'hello caller' } }
    });
    assert.strictEqual(trans.kind, 'text');
    assert.strictEqual(trans.text, 'hello caller');
    var tool = live.greetingClassifyOutput({ toolCall: { functionCalls: [{}] } });
    assert.strictEqual(tool.kind, 'tool');
  },

  'getDiag carries the greeting counters': async function () {
    var t = await started({ greetingNudgeMs: 50, greetingFailMs: 500 });
    var d = t.session.getDiag();
    assert.strictEqual(d.greetingState, 'trigger_sent');
    assert.ok(d.triggerSentAt > 0, 'triggerSentAt recorded');
    assert.strictEqual(d.retrySentAt, 0, 'no retry yet');
    assert.strictEqual(d.firstOutputAt, 0, 'no output yet');
    assert.strictEqual(d.outputKind, null);
    t.mock.callbacks.onmessage({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] } }
    });
    await tick();
    var d2 = t.session.getDiag();
    assert.strictEqual(d2.greetingState, 'audio_received');
    assert.ok(d2.firstOutputAt >= d2.triggerSentAt, 'firstOutputAt after trigger');
    assert.strictEqual(d2.outputKind, 'audio');
    await t.session.hangup();
  },

  'GreetingDiag collects the timeline and reports': function () {
    delete require.cache[require.resolve('../public/greeting.js')];
    require('../public/greeting.js');
    var G = global.window.GreetingDiag;
    assert.ok(G, 'window.GreetingDiag defined');
    G.reset();
    var seen = [];
    var h = G.attach(function (listener) {
      seen.push(typeof listener);
      return function () { seen.push('unsubscribed'); };
    });
    assert.strictEqual(seen[0], 'function', 'listener subscribed');
    h.feed({ type: 'greeting_state', state: 'trigger_sent', detail: { attempt: 1 } });
    h.feed({ type: 'setup_complete', model: 'x' }); // unrelated: recorded, ignored
    h.feed({ type: 'greeting_state', state: 'retry_sent', detail: { attempt: 2 } });
    h.feed({ type: 'greeting_state', state: 'text_received',
             detail: { outputKind: 'text', latencyMs: 1234, text: 'Hello!' } });
    h.feed({ type: 'greeting_text_only', text: 'Hello!' });
    assert.deepStrictEqual(G.getReport(), {
      triggerSent: true, retried: true, firstOutputMs: 1234, outputKind: 'text', failed: false
    });
    assert.strictEqual(h.timeline().length, 5, 'full timeline recorded');
    h.detach();
    assert.strictEqual(seen[seen.length - 1], 'unsubscribed');
    G.reset();
    assert.deepStrictEqual(G.getReport(), {
      triggerSent: false, retried: false, firstOutputMs: null, outputKind: null, failed: false
    });
  },

  'GreetingDiag records failure': function () {
    delete require.cache[require.resolve('../public/greeting.js')];
    require('../public/greeting.js');
    var G = global.window.GreetingDiag;
    G.reset();
    var h = G.attach(null);
    h.feed({ type: 'greeting_state', state: 'trigger_sent', detail: { attempt: 1 } });
    h.feed({ type: 'greeting_failed', hint: 'Say hello to begin' });
    var r = G.getReport();
    assert.strictEqual(r.triggerSent, true);
    assert.strictEqual(r.failed, true);
    assert.strictEqual(r.outputKind, null);
    G.reset();
  }
};
