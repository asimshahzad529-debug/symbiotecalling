'use strict';
/* public/recorder.js — client-side call recorder (UMD).
 *
 * Records whatever MediaStream the caller hands it. The integrator is
 * expected to pass a combined stream (agent output via
 * MediaStreamAudioDestinationNode + the caller's mic track); this module
 * only records, it never touches capture or mixing.
 *
 * Browser: window.CallRecorder.  Node: require('./recorder.js').
 * Zero dependencies, 'use strict', var-style.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CallRecorder = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Preferred-first list; the first entry the platform claims to support wins. */
  var CANDIDATE_TYPES = ['audio/webm;codecs=opus', 'audio/webm'];

  function mediaRecorderCtor() {
    if (typeof window !== 'undefined' && window.MediaRecorder) return window.MediaRecorder;
    return null;
  }

  function CallRecorder() {
    this._state = 'idle';      /* idle | recording | stopped | error */
    this._chunks = [];
    this._recorder = null;
    this._mimeType = '';
    this._startTime = 0;
    this._stopTime = 0;
    this._resolve = null;      /* pending stop() resolver */
  }

  /* True only where a real browser MediaRecorder exists. */
  CallRecorder.isSupported = function () {
    return typeof window !== 'undefined' && !!window.MediaRecorder;
  };

  CallRecorder.prototype.getState = function () {
    return this._state;
  };

  CallRecorder.prototype.getElapsedMs = function () {
    if (this._state === 'idle') return 0;
    if (this._state === 'recording') return Date.now() - this._startTime;
    return this._stopTime - this._startTime;
  };

  /* Start recording `mediaStream`. Returns true when recording began,
   * false when unsupported, already recording, or the stream is falsy. */
  CallRecorder.prototype.start = function (mediaStream) {
    var MR = mediaRecorderCtor();
    if (!MR) return false;
    if (this._state === 'recording') return false;
    if (!mediaStream) return false;

    var mimeType = '';
    if (typeof MR.isTypeSupported === 'function') {
      for (var i = 0; i < CANDIDATE_TYPES.length; i++) {
        try {
          if (MR.isTypeSupported(CANDIDATE_TYPES[i])) { mimeType = CANDIDATE_TYPES[i]; break; }
        } catch (e) { /* treat as unsupported, keep looking */ }
      }
    }
    /* No isTypeSupported guard: pass no type and let the platform pick. */

    var self = this;
    this._chunks = [];
    this._mimeType = mimeType;
    try {
      var rec = mimeType ? new MR(mediaStream, { mimeType: mimeType }) : new MR(mediaStream);
      rec.ondataavailable = function (e) {
        if (e && e.data && (typeof e.data.size !== 'number' || e.data.size > 0)) {
          self._chunks.push(e.data);
        }
      };
      rec.onstop = function () {
        self._state = 'stopped';
        self._stopTime = Date.now();
        self._recorder = null;
        var resolve = self._resolve;
        self._resolve = null;
        var blob = null;
        try {
          if (self._chunks.length) blob = new Blob(self._chunks, { type: self._mimeType });
        } catch (e) { blob = null; }
        if (resolve) resolve(blob);
      };
      rec.onerror = function () {
        self._state = 'error';
        self._stopTime = Date.now();
        self._recorder = null;
        var resolve = self._resolve;
        self._resolve = null;
        if (resolve) resolve(null);
      };
      rec.start(1000); /* 1s timeslice: periodic chunks on real browsers */
      this._recorder = rec;
      this._startTime = Date.now();
      this._state = 'recording';
      return true;
    } catch (e) {
      this._state = 'error';
      this._recorder = null;
      return false;
    }
  };

  /* Stop recording. Resolves to the recorded Blob, or null when never
   * recording / no data / unsupported. Never rejects. */
  CallRecorder.prototype.stop = function () {
    var self = this;
    return new Promise(function (resolve) {
      var MR = mediaRecorderCtor();
      if (!MR || self._state !== 'recording' || !self._recorder) { resolve(null); return; }
      self._resolve = resolve;
      try {
        self._recorder.stop();
      } catch (e) {
        self._resolve = null;
        self._state = 'error';
        self._stopTime = Date.now();
        resolve(null);
      }
    });
  };

  return CallRecorder;
}));
