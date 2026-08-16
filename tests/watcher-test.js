// The n8n-native watcher, tested as the artifact that actually ships.
//
// This does not re-implement the workflow's logic - it pulls the jsCode out of
// the built workflow JSON and runs it against a simulated n8n Code-node
// environment. If the file someone imports is wrong, this fails.
//
// The behaviour that matters most is across POLLS, not within one: static
// data has to carry the watermark and the shape profiles from run to run, or
// drift detection silently never works in production.
const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'watcher', 'why-watch-n8n.json');
if (!fs.existsSync(wfPath)) {
  console.log('  FAIL  watcher workflow not built - run: node build-watcher.js');
  process.exit(1);
}
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
const codeOf = name => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) { console.log('  FAIL  no node named ' + name); process.exit(1); }
  return n.parameters.jsCode;
};

const CFG = { n8nBaseUrl: 'https://n8n.test', alertWebhookUrl: 'https://hooks.test/x' };

// Persistent across polls, exactly as $getWorkflowStaticData('global') is.
let memory = {};

function runNode(code, items) {
  const $input = {
    all: () => items,
    first: () => items[0]
  };
  const $ = name => {
    if (name === 'Settings') return { first: () => ({ json: CFG }) };
    throw new Error('unexpected $("' + name + '")');
  };
  const $getWorkflowStaticData = () => memory;
  return new Function('$input', '$', '$getWorkflowStaticData',
    code + '\n//# sourceURL=node.js')($input, $, $getWorkflowStaticData);
}

/* ---- fixtures ---------------------------------------------------------- */

function execJson(id, opts) {
  opts = opts || {};
  const out = opts.empty ? [] : [{ json: opts.payload || { summary: 'ok', ref: 'ACC-88421905' } }];
  // `ai` makes the result node a model node, which is the only kind provenance
  // applies to - a Code node minting a reference number is not making it up.
  const type = opts.filterNode ? 'n8n-nodes-base.filter'
             : opts.ai ? '@n8n/n8n-nodes-langchain.agent'
             : 'n8n-nodes-base.code';
  return {
    id: id, workflowId: 'WF1', status: 'success',
    workflowData: {
      name: 'Lead Enrichment',
      nodes: [
        { name: 'Trigger', type: 'n8n-nodes-base.webhook' },
        { name: 'Build', type: type }
      ],
      connections: { Trigger: { main: [[{ node: 'Build', type: 'main', index: 0 }]] } }
    },
    data: { resultData: { runData: {
      Trigger: [{ executionIndex: 0, data: { main: [[{ json: { company: 'Northgate Legal' } }]] } }],
      Build: [{ executionIndex: 1, source: [{ previousNode: 'Trigger' }], data: { main: [out] } }]
    } } }
  };
}

const listOf = ids => [{ json: { data: ids.map(id => ({ id: String(id), status: 'success' })) } }];

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

const pick = codeOf('Only what is new');
const engine = codeOf('why? engine');

/* ---- poll 1: a fresh install with a backlog ---------------------------- */

let fresh = runNode(pick, listOf([12, 11, 10]));
check('first poll returns nothing, however bad the backlog', fresh.length === 0,
  fresh.length + ' items');
check('but it records the high-water mark', Number(memory.watermark) === 12,
  'watermark=' + memory.watermark);

/* ---- poll 2: two new broken runs --------------------------------------- */

fresh = runNode(pick, listOf([14, 13, 12]));
check('second poll picks up only the two new runs', fresh.length === 2,
  fresh.map(f => f.json.id).join(', '));

let out = runNode(engine, [
  { json: execJson('14', { empty: true }) },
  { json: execJson('13', { empty: true }) }
]);
check('both are reported as findings', out.length === 1 && out[0].json.findingCount === 2,
  out.length ? JSON.stringify(out[0].json.findingCount) : 'no message');
check('the alert names the workflow and the execution',
  out.length && /Lead Enrichment/.test(out[0].json.text) && /#14/.test(out[0].json.text),
  out.length ? out[0].json.text.split('\n')[2] : '');
check('the alert is sent in a shape both Slack and Discord accept',
  out.length && out[0].json.text && out[0].json.content);

/* ---- a Filter emptying is the workflow working ------------------------- */

out = runNode(engine, [{ json: execJson('15', { empty: true, filterNode: true }) }]);
check('a Filter that kept nothing raises no alert', out.length === 0);

/* ---- drift, which only works if profiles survive between polls --------- */

const healthy = i => ({
  summary: 'Operations Director at Northgate Legal, a 45-person firm in Manchester. '
         + 'Strong fit for the mid-market tier based on headcount. Run ' + i + '.',
  ref: 'ACC-88421905'
});

// Twelve healthy runs, delivered across twelve separate polls.
for (let i = 0; i < 12; i++) {
  const r = runNode(engine, [{ json: execJson(String(100 + i), { payload: healthy(i) }) }]);
  if (r.length) { check('healthy run ' + i + ' raised no alert', false, r[0].json.text); }
}
check('twelve healthy runs across twelve polls raise nothing', true);
check('the profile survived between polls',
  memory.profiles && Object.keys(memory.profiles).length === 1
  && memory.profiles['WF1|Build'].runs >= 12,
  'profile runs = ' + (memory.profiles && memory.profiles['WF1|Build']
    ? memory.profiles['WF1|Build'].runs : 'none'));

// Now the model starts refusing.
out = runNode(engine, [{ json: execJson('120', {
  payload: { summary: "I'm sorry, I can't help with that.", ref: 'ACC-88421905' }
}) }]);
check('the refusal is caught as a shape change', out.length === 1
  && /changed shape/.test(out[0].json.text),
  out.length ? out[0].json.text.split('\n')[2] : 'no alert');
check('and the alert quotes the refusal verbatim',
  out.length && /I'm sorry/.test(out[0].json.text),
  out.length ? out[0].json.text : '');

/* ---- invented details -------------------------------------------------- */

out = runNode(engine, [{ json: execJson('130', {
  ai: true,
  payload: { summary: 'Northgate Legal, a 45-person firm in Manchester, billing at '
    + 'accounts@northgate-invoices-ltd.net' }
}) }]);
check('a domain a model produced from nowhere is reported',
  out.length === 1 && /invented details/.test(out[0].json.text),
  out.length ? out[0].json.text.split('\n')[2] : 'no alert');

// The same output from a Code node is ordinary behaviour, not a hallucination.
out = runNode(engine, [{ json: execJson('131', {
  payload: { summary: 'Billing at accounts@northgate-invoices-ltd.net', ref: 'INV-99123456' }
}) }]);
check('the same output from a Code node raises nothing',
  !out.length || !/invented details/.test(out[0].json.text),
  out.length ? out[0].json.text.split('\n')[2] : 'no alert');

/* ---- the profile store must not grow without bound --------------------- */

check('profile store stays bounded',
  Object.keys(memory.profiles).length <= 200,
  Object.keys(memory.profiles).length + ' profiles');

console.log('\n  ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
