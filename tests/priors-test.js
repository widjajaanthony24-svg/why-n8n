// Node-type priors: what makes a brand-new workflow judgeable from run one.
//
// Drift normally needs 8+ runs of a node before it will say anything, so a
// workflow you built this morning gets nothing. But what an OpenAI node emits
// does not change between your workflows - so the fortieth workflow can be
// judged using what the other thirty-nine taught it.
//
// This is also the only thing here that compounds: a fresh copy of this code
// starts with no priors and stays that way for weeks. So the safety property
// matters as much as the capability - a prior pooled across DIFFERENT
// workflows must not start inventing findings.
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const grab = (re, name) => {
  const m = src.match(re);
  if (!m) { console.log('could not extract ' + name); process.exit(1); }
  return m[0];
};

let ignored = {}, typeProfiles = Object.create(null), saved = null;
const dict = () => Object.create(null);
const store = { set: p => { saved = p; } };
const TYPE_PROFILE_MAX = 40;

const scope = [
  grab(/function saveTypeProfiles\(\)[\s\S]*?\n  \}/, 'saveTypeProfiles'),
  grab(/function driftScan\(results, byId\)[\s\S]*?\n  \}/, 'driftScan'),
  'return { driftScan, get profiles(){return typeProfiles;} };'
].join('\n');

const M = new Function('E', 'ignored', 'typeProfiles', 'store', 'dict', 'TYPE_PROFILE_MAX',
  scope)(E, ignored, typeProfiles, store, dict, TYPE_PROFILE_MAX);

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

const AGENT = '@n8n/n8n-nodes-langchain.agent';
let clock = Date.now() - 86400000;
const byId = {};

function run(wfId, node, type, sample) {
  const id = String(Math.floor(Math.random() * 1e9));
  byId[id] = { startedAt: new Date(clock += 60000).toISOString() };
  return { id, v: null, failed: null, workflowId: wfId, workflowName: wfId,
           resultNode: node, resultType: type, sample };
}

const good = (wf, i) => ({
  output: 'Enrichment complete for record ' + i + ' at ' + wf
        + '. The account is active and in good standing across all regions.',
  confidence: 0.9
});

/* ---- an established workflow teaches the type -------------------------- */

let results = [];
for (let i = 0; i < 14; i++) results.push(run('WF-OLD', 'Agent', AGENT, good('WF-OLD', i)));
let res = M.driftScan(results, byId);

check('an established workflow is judged on its own history', res.judged > 0,
  res.judged + ' judged');
check('and it raises nothing while healthy', res.found.length === 0,
  res.found.map(f => f.drift[0].field).join(', '));
check('the node type prior is now learned',
  M.profiles[AGENT] && M.profiles[AGENT].runs >= 14,
  'prior runs = ' + (M.profiles[AGENT] ? M.profiles[AGENT].runs : 'none'));
check('and it was persisted', saved && saved.typeProfiles && saved.typeProfiles[AGENT]);

/* ---- a brand-new workflow, judged from run one ------------------------- */

// Three runs only - far below the 8 it would need to know itself.
results = [];
for (let i = 0; i < 2; i++) results.push(run('WF-NEW', 'Agent', AGENT, good('WF-NEW', i)));
results.push(run('WF-NEW', 'Agent', AGENT,
  { output: "I'm sorry, I can't help with that.", confidence: 0.9 }));

res = M.driftScan(results, byId);
check('a 3-run workflow IS judged, using the prior', res.byPrior === 3,
  'byPrior=' + res.byPrior + ', judged=' + res.judged);
check('and the refusal is caught on a workflow with no history of its own',
  res.found.length === 1 && res.found[0].drift[0].field === 'output',
  res.found.length ? res.found[0].drift[0].kind + ' on ' + res.found[0].drift[0].field : 'nothing found');
check('the finding says the yardstick was other workflows',
  res.found.length && res.found[0].fromPrior === AGENT,
  res.found.length ? String(res.found[0].fromPrior) : '');

/* ---- the safety property ---------------------------------------------- */

// A different workflow whose healthy output is simply shaped differently must
// not be flagged just for being unlike the workflows that built the prior.
results = [];
for (let i = 0; i < 3; i++) {
  results.push(run('WF-OTHER', 'Agent', AGENT, {
    output: 'Ticket routed to the billing queue with priority two and an SLA of four hours.',
    ticket_id: 'T-' + (900 + i),
    queue: 'billing'
  }));
}
res = M.driftScan(results, byId);
check('a differently-shaped but healthy workflow is not flagged by the prior',
  res.found.length === 0,
  res.found.map(f => f.drift.map(d => d.field + ' ' + d.kind).join('/')).join('; '));

// A node type nobody has run enough must not be judged at all.
results = [];
for (let i = 0; i < 3; i++) {
  results.push(run('WF-RARE', 'Odd', 'n8n-nodes-base.someRareThing', { value: 'x'.repeat(50) }));
}
results.push(run('WF-RARE', 'Odd', 'n8n-nodes-base.someRareThing', { value: 'x' }));
res = M.driftScan(results, byId);
check('a node type with too little history judges nothing',
  res.byPrior === 0 && res.found.length === 0,
  'byPrior=' + res.byPrior + ', found=' + res.found.length);

check('the prior store stays bounded',
  Object.keys(M.profiles).length <= TYPE_PROFILE_MAX,
  Object.keys(M.profiles).length + ' types');

console.log('\n  ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
