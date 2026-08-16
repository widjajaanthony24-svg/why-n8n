const path = require('path');
// Tests driftScan: the part that decides WHICH runs form the baseline and
// which get judged. Extracted from content.js so it runs outside the browser.
const fs = require('fs');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const m = src.match(/function driftScan\(results, byId\)[\s\S]*?\n  \}/);
if (!m) { console.log('could not extract driftScan'); process.exit(1); }

let ignored = {};
const dict = () => Object.create(null);     // driftScan uses the same helper content.js does
const typeProfiles = dict();                // node-type priors, irrelevant to this suite
const saveTypeProfiles = () => {};
const driftScan = eval('(' + m[0] + ')');   // closes over E, ignored, dict and the priors

function good(i) {
  return {
    summary: 'Operations Director at Northgate Legal, a 45-person firm in Manchester. '
           + 'Strong fit for the mid-market tier based on headcount. Run ' + i + '.',
    confidence: 0.9,
    tier: i % 2 ? 'mid-market' : 'enterprise'
  };
}

// 20 runs of one workflow. The last two degrade: the model starts refusing.
const results = [];
const byId = {};
for (let i = 0; i < 20; i++) {
  const id = String(100 + i);
  const degraded = i >= 18;
  results.push({
    id, v: null, failed: null,
    workflowId: 'WF1', workflowName: 'Lead Enrichment',
    resultNode: 'Build CRM Record',
    sample: degraded
      ? Object.assign(good(i), { summary: 'I cannot determine that.' })
      : good(i)
  });
  byId[id] = { startedAt: new Date(Date.now() - (20 - i) * 3600000).toISOString() };
}

// A second workflow with only 4 clean runs - must be left alone entirely.
for (let i = 0; i < 4; i++) {
  const id = String(300 + i);
  results.push({
    id, v: null, failed: null,
    workflowId: 'WF2', workflowName: 'Tiny Workflow',
    resultNode: 'Do Thing',
    sample: { note: i === 3 ? 'x' : 'a much longer note than that one here' }
  });
  byId[id] = { startedAt: new Date(Date.now() - (4 - i) * 3600000).toISOString() };
}

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

const res = driftScan(results, byId);
const found = res.found;
const ids = found.map(f => f.run.id);

// The panel shows its working, so the counts behind the verdict must be real.
check('reports how many runs it judged and how many were too new',
  res.judged > 0 && res.thin === 4,
  res.judged + ' judged, ' + res.thin + ' too new to judge');

check('flags the two degraded runs', ids.includes('118') && ids.includes('119'),
  found.map(f => '#' + f.run.id + ' ' + f.drift[0].field + ' ' + f.drift[0].kind).join('; ') || 'none');
check('does not flag any of the 18 healthy runs',
  !ids.some(id => Number(id) < 118));
check('leaves the 4-run workflow alone (too little history)',
  !ids.some(id => Number(id) >= 300));
check('names the field and what changed',
  found.length > 0 && found[0].drift[0].field === 'summary' && found[0].drift[0].kind === 'shrank',
  found.length ? JSON.stringify(found[0].drift[0]) : '');

// An ignored node must vanish from the results.
ignored = { 'WF1|Build CRM Record': true };
check('respects the ignore list', driftScan(results, byId).found.length === 0);

console.log('\n  ' + pass + '/' + total + ' passed');
