'use strict';
/* tests/run.js — tiny zero-dependency test runner. */
var fs = require('fs');
var path = require('path');

var files = fs.readdirSync(__dirname).filter(function (f) { return f.endsWith('.test.js'); }).sort();
var pass = 0, fail = 0, failed = [];

(async function () {
  for (const f of files) {
    var tests = require(path.join(__dirname, f));
    for (const name of Object.keys(tests)) {
      try {
        await tests[name]();
        pass++;
        console.log('  ok   ' + f + ' :: ' + name);
      } catch (e) {
        fail++;
        failed.push(f + ' :: ' + name + ' — ' + (e && e.message));
        console.log('  FAIL ' + f + ' :: ' + name + '\n         ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n         ') : e));
      }
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
})();
