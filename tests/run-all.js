// Runs every suite plus the fixture regression. No dependencies, no build step.
//
//   node tests/run-all.js
//
// Exits non-zero if anything fails, so it works as a pre-commit or CI check.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const here = __dirname;
const suites = ['attack-test.js', 'drift-test.js', 'driftscan-test.js', 'rank-test.js',
                'history-test.js', 'provenance-test.js', 'agent-test.js', 'scope-test.js',
                'watch-test.js', 'watcher-test.js', 'diagnose-test.js', 'priors-test.js',
                'compare-test.js', 'universal-test.js', 'refs-test.js', 'smoke-test.js'];

let failed = 0;
let totalPass = 0, totalRun = 0;

for (const s of suites) {
  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath, [path.join(here, s)], { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    ok = false;
  }
  const m = out.match(/(\d+)\/(\d+) passed/);
  if (m) {
    totalPass += Number(m[1]);
    totalRun += Number(m[2]);
    if (m[1] !== m[2]) ok = false;
  } else {
    ok = false;
  }
  console.log((ok ? '  ok    ' : '  FAIL  ') + s.padEnd(22) + (m ? m[0] : 'did not report a result'));
  if (!ok) {
    failed++;
    console.log(out.split('\n').filter(l => /FAIL|Error/.test(l)).map(l => '        ' + l).join('\n'));
  }
}

// Fixture regression: real execution JSON captured from n8n.
require(path.join(here, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;
const fixDir = path.join(here, '..', 'fixtures');
let fixPass = 0, fixRun = 0;

if (fs.existsSync(fixDir)) {
  for (const f of fs.readdirSync(fixDir).filter(x => x.endsWith('.json'))) {
    fixRun++;
    // Strip any BOM - one silently broke a check early on, and a fixture that
    // fails to parse must never read as "nothing wrong here".
    const raw = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8').replace(/^﻿/, ''));
    const v = E.verdict(E.normalise(raw));
    const expectClean = f === 'baseline.json';
    if (expectClean ? !v : !!v) fixPass++;
    else console.log('  FAIL  fixture ' + f + ' -> ' + (v ? v.text : 'CLEAN'));
  }
  console.log((fixPass === fixRun ? '  ok    ' : '  FAIL  ') + 'fixtures'.padEnd(22) + fixPass + '/' + fixRun + ' passed');
  if (fixPass !== fixRun) failed++;
} else {
  console.log('  FAIL  fixtures              directory missing');
  failed++;
}

console.log('\n  ' + (totalPass + fixPass) + '/' + (totalRun + fixRun) + ' checks passed across '
  + (suites.length + 1) + ' suites');

if (failed) {
  console.log('  ' + failed + ' suite(s) failed');
  process.exit(1);
}
