'use strict';
/* public/summary.js — client-side auto call summaries (feature 4, v6.0.0).
   UMD: works in Node (require) and in the browser (window.CallSummary).
   Fire-and-forget helper: given a call transcript, asks a cheap Gemini text
   model for a short plain-text summary + an "Outcome:" line. Never throws —
   summarize() always resolves (null on any failure). */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CallSummary = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  var SUMMARY_MODEL = 'gemini-3.1-flash-live-preview';
  var ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/' + SUMMARY_MODEL + ':generateContent';
  var MAX_TRANSCRIPT_CHARS = 6000;
  var MAX_SUMMARY_CHARS = 2000;

  function speakerLabel(who) {
    return who === 'agent' ? 'Agent' : 'Caller';
  }

  function transcriptText(transcript) {
    var lines = [];
    var total = 0;
    // Walk oldest-first; drop oldest lines when over budget.
    var kept = [];
    var i, line;
    for (i = 0; i < transcript.length; i++) {
      var entry = transcript[i] || {};
      line = speakerLabel(entry.who) + ': ' + (entry.text || '');
      kept.push(line);
      total += line.length;
    }
    while (total > MAX_TRANSCRIPT_CHARS && kept.length > 1) {
      total -= kept.shift().length;
    }
    lines = kept;
    return lines.join('\n');
  }

  function buildPrompt(transcript) {
    transcript = Array.isArray(transcript) ? transcript : [];
    var body = transcriptText(transcript);
    return 'Summarize this phone call between an AI calling agent and a caller.\n' +
      'Write a 3-4 line plain-text summary of what happened on the call.\n' +
      'Then write one final line starting exactly with "Outcome: " describing how the call ended ' +
      '(for example: appointment booked, question answered, lead captured, transferred to another agent).\n' +
      'Plain text only — no markdown, no JSON, no bullet lists.\n\n' +
      'Transcript:\n' + body;
  }

  function summarize(apiKey, transcript) {
    if (!apiKey || !Array.isArray(transcript) || transcript.length === 0) {
      return Promise.resolve(null);
    }
    if (typeof fetch === 'undefined') {
      return Promise.resolve(null);
    }
    var prompt;
    try {
      prompt = buildPrompt(transcript);
    } catch (e) {
      return Promise.resolve(null);
    }
    var body;
    try {
      body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
      });
    } catch (e) {
      return Promise.resolve(null);
    }
    return Promise.resolve()
      .then(function () {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },
          body: body
        });
      })
      .then(function (res) {
        if (!res || !res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.candidates) || !data.candidates.length) return null;
        var parts = data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        if (!Array.isArray(parts) || !parts.length) return null;
        var text = parts.map(function (p) { return (p && p.text) || ''; }).join('').trim();
        if (!text) return null;
        return text.slice(0, MAX_SUMMARY_CHARS);
      })
      .catch(function () { return null; });
  }

  var CallSummary = {
    SUMMARY_MODEL: SUMMARY_MODEL,
    ENDPOINT: ENDPOINT,
    MAX_TRANSCRIPT_CHARS: MAX_TRANSCRIPT_CHARS,
    MAX_SUMMARY_CHARS: MAX_SUMMARY_CHARS,
    buildPrompt: buildPrompt,
    summarize: summarize
  };
  return CallSummary;
}));
