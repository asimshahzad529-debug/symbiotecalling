'use strict';
/* tests/transfer.test.js — Feature 1 of v6: SymAgent-only call transfer (server-side). */
var assert = require('assert');
var live = require('../src/live');
var prompt = require('../src/prompt');
var agents = require('../src/agents');

module.exports = {
  'resolveTransferTarget resolves by agent id': function () {
    var r = live.resolveTransferTarget({ agentId: 'lina' });
    assert.ok(r.ok, 'expected ok');
    assert.deepStrictEqual(Object.keys(r.target).sort(), ['id', 'name', 'niche', 'number']);
    assert.strictEqual(r.target.id, 'lina');
    assert.strictEqual(r.target.name, 'Elena');
    assert.strictEqual(r.target.number, '+1 (555) 010-0003');
    assert.strictEqual(r.target.niche, 'Travel Concierge');
  },
  'resolveTransferTarget resolves by number': function () {
    var r = live.resolveTransferTarget({ number: '+1 (555) 010-0001' });
    assert.ok(r.ok, 'expected ok');
    assert.strictEqual(r.target.id, 'ava');
    assert.strictEqual(r.target.number, '+1 (555) 010-0001');
    assert.ok(r.target.name && r.target.niche, 'target has name and niche');
  },
  'resolveTransferTarget rejects unknown id and number': function () {
    var a = live.resolveTransferTarget({ agentId: 'nope-xyz' });
    assert.ok(!a.ok && a.error, 'unknown id rejected');
    var b = live.resolveTransferTarget({ number: '+1 (555) 010-9999' });
    assert.ok(!b.ok && b.error, 'unknown number rejected');
  },
  'resolveTransferTarget rejects self-transfer': function () {
    var r = live.resolveTransferTarget({ agentId: 'symagent' });
    assert.ok(!r.ok && r.error, 'self-transfer rejected');
  },
  'resolveTransferTarget rejects empty args': function () {
    assert.ok(!live.resolveTransferTarget({}).ok, 'empty object rejected');
    assert.ok(!live.resolveTransferTarget(null).ok, 'null rejected');
    assert.ok(!live.resolveTransferTarget(undefined).ok, 'undefined rejected');
  },
  'toolNamesFor gates symagent-only tools': function () {
    var sym = live.toolNamesFor('symagent');
    assert.ok(sym.indexOf('transfer_call') !== -1, 'symagent gets transfer_call');
    assert.ok(sym.indexOf('share_links') !== -1, 'symagent keeps share_links');
    var lina = live.toolNamesFor('lina');
    assert.ok(lina.indexOf('transfer_call') === -1, 'ordinary agent has no transfer_call');
    assert.ok(lina.indexOf('share_links') === -1, 'ordinary agent has no share_links');
    assert.ok(['get_datetime', 'web_search', 'save_note', 'end_call'].every(function (t) {
      return lina.indexOf(t) !== -1 && sym.indexOf(t) !== -1;
    }), 'base tools present for both');
  },
  'executeTool transfer_call emits transfer_requested and returns ok': async function () {
    var events = [];
    var r = await live.executeTool('transfer_call', { agentId: 'lina' }, {
      emit: function (ev) { events.push(ev); }
    });
    assert.ok(r.ok, 'expected ok:true');
    assert.strictEqual(r.note, 'Say one brief handoff sentence, then say nothing more; the transfer is being connected.');
    assert.deepStrictEqual(r.transfer, { id: 'lina', name: 'Elena', number: '+1 (555) 010-0003', niche: 'Travel Concierge' });
    assert.strictEqual(events.length, 1, 'exactly one event emitted');
    assert.strictEqual(events[0].type, 'transfer_requested');
    assert.deepStrictEqual(events[0].target, r.transfer);
  },
  'executeTool transfer_call fails cleanly on bad target': async function () {
    var events = [];
    var r = await live.executeTool('transfer_call', { agentId: 'ghost' }, {
      emit: function (ev) { events.push(ev); }
    });
    assert.ok(!r.ok && r.error, 'expected ok:false with error');
    assert.strictEqual(events.length, 0, 'no event emitted on failure');
  },
  'prompt documents transfer for symagent only': function () {
    var inst = prompt.buildAgentInstruction(agents.getById('symagent'), null);
    assert.ok(/TRANSFERRING TO A SPECIALIST/.test(inst), 'transfer section present');
    assert.ok(/transfer_call/.test(inst), 'transfer_call bullet present');
    assert.ok(/Should I connect you to <name>\?/.test(inst), 'confirm-first wording present');
    assert.ok(/Never transfer to yourself/.test(inst), 'self-transfer ban present');
    var lina = prompt.buildAgentInstruction(agents.getById('lina'), null);
    assert.ok(!/transfer_call/.test(lina), 'ordinary agents get no transfer docs');
    // Existing symagent text untouched.
    assert.ok(/share_links: use when the caller asks for socials/.test(inst), 'share_links bullet intact');
    assert.ok(/THE 100 CALLING AGENTS/.test(inst), 'agent directory intact');
  }
};
