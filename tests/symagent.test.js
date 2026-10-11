'use strict';
/* tests/symagent.test.js — the 101st agent: SymAgent, company rep with share_links. */
var assert = require('assert');
var agents = require('../src/agents');
var prompt = require('../src/prompt');
var live = require('../src/live');

module.exports = {
  'SymAgent exists with its own number': function () {
    var s = agents.getById('symagent');
    assert.ok(s, 'symagent present');
    assert.strictEqual(s.name, 'SymAgent');
    assert.strictEqual(s.number, '+1 (555) 010-0101');
    assert.strictEqual(agents.getByNumber('+1 (555) 010-0101').id, 'symagent');
    assert.strictEqual(agents.getByNumber('5550100101').id, 'symagent');
  },
  'prompt carries company knowledge and the 100-agent directory': function () {
    var s = agents.getById('symagent');
    var inst = prompt.buildAgentInstruction(s, null);
    assert.ok(/symbiotesystemsofficial@gmail\.com/i.test(inst), 'contact email in knowledge');
    assert.ok(/314 2580054/.test(inst), 'whatsapp in knowledge');
    assert.ok(/share_links/i.test(inst), 'share_links usage documented');
    assert.ok(/THE 100 CALLING AGENTS/i.test(inst), 'agent directory injected');
    assert.ok(/Jacob \(Real Estate Advisor, 0001\)/.test(inst), 'directory lists agents');
    assert.ok(/Aurora \(Comedy Coach, 0100\)/.test(inst), 'directory reaches the last agent');
    var roster = (inst.split('Full roster')[1] || '').split('If asked about a specific agent')[0];
    assert.ok(!/SymAgent/.test(roster), 'roster excludes SymAgent itself');
    // Ordinary agents get neither knowledge nor the directory.
    var lina = prompt.buildAgentInstruction(agents.getById('lina'), null);
    assert.ok(!/COMPANY KNOWLEDGE/.test(lina), 'ordinary agents have no company knowledge');
  },
  'share_links emits only official server-side URLs': async function () {
    var events = [];
    var r = await live.executeTool('share_links', { set: 'socials' }, { emit: function (ev) { events.push(ev); } });
    assert.ok(r.ok, 'socials set works');
    assert.strictEqual(r.shared, 6, 'six social links, no Facebook');
    var ev = events[0];
    assert.strictEqual(ev.type, 'links_shared');
    assert.ok(ev.links.every(function (l) { return /^https:\/\//.test(l.url) && l.label; }), 'all https with labels');
    assert.ok(!ev.links.some(function (l) { return /facebook/i.test(l.url); }), 'no facebook link');
    assert.ok(ev.links.some(function (l) { return /instagram\.com\/symbiotesystems/.test(l.url); }), 'instagram present');

    var r2 = await live.executeTool('share_links', { set: 'portfolio' }, { emit: function (ev2) { events.push(ev2); } });
    assert.ok(r2.ok && r2.shared === 3, 'three portfolio links');
    assert.ok(events[1].links.some(function (l) { return /aquiferreachllc/.test(l.url); }), 'client work included');

    var r3 = await live.executeTool('share_links', { set: 'contact' }, { emit: function () {} });
    assert.ok(r3.ok && r3.shared === 2, 'email + whatsapp');

    var r4 = await live.executeTool('share_links', { set: 'all' }, { emit: function () {} });
    assert.ok(r4.ok && r4.shared === 11, 'all = 6 + 3 + 2');

    var bad = await live.executeTool('share_links', { set: 'nope' }, { emit: function () {} });
    assert.ok(!bad.ok, 'unknown set rejected');
  }
};
