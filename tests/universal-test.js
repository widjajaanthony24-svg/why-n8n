// The two silent failures that hit workflows with no AI in them at all.
//
// Most of this tool's newer detection needs a model in the loop, which is no
// use to the majority of n8n workflows - Code, HTTP, Sheets, Slack. These two
// bite those workflows and appear nowhere in n8n's own UI:
//
//   1. a 200 response carrying an error in its body
//   2. items quietly going missing partway through a batch
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

function exec(nodes, runData, connections) {
  return { id: '1', workflowId: 'WF1', status: 'success',
           workflowData: { nodes, connections: connections || {} },
           data: { resultData: { runData } } };
}

function httpRun(body) {
  return exec(
    [{ name: 'Call API', type: 'n8n-nodes-base.httpRequest' }],
    { 'Call API': [{ executionIndex: 0, data: { main: [[{ json: body }]] } }] }
  );
}

/* ---- error-shaped payloads in a successful run ------------------------- */

const shouldFlag = [
  ['a rate limit in the body', { error: 'Rate limit exceeded. Retry after 60s.' }],
  ['an errors array with entries', { errors: [{ code: 'INVALID_FIELD' }], data: null }],
  ['success: false', { success: false, message: 'Token expired' }],
  ['status: "failed"', { status: 'failed', id: 991 }],
  ['a 429 in the body', { statusCode: 429, message: 'Too many requests' }],
  ['ok: false', { ok: false, description: 'chat not found' }],
  ['an exception field', { exception: 'NullReferenceException at line 12' }]
];
shouldFlag.forEach(([label, body]) => {
  const got = E.errorPayloads(httpRun(body));
  check('flags ' + label, got.length === 1, got.length ? JSON.stringify(got[0]) : 'nothing flagged');
});

const shouldNotFlag = [
  ['a clean response', { id: 991, name: 'Northgate Legal', tier: 'enterprise' }],
  ['error explicitly null', { error: null, data: { id: 1 } }],
  ['an empty errors array', { errors: [], data: { id: 1 } }],
  ['success: true', { success: true, id: 4 }],
  ['status: "active"', { status: 'active', id: 4 }],
  ['a 200 status code', { statusCode: 200, body: 'ok' }],
  ['a numeric field that happens to be called code', { code: 200, label: 'OK' }],
  ['prose that merely mentions the word error', { summary: 'No error was found in the audit.' }]
];
shouldNotFlag.forEach(([label, body]) => {
  const got = E.errorPayloads(httpRun(body));
  check('stays quiet on ' + label, got.length === 0, got.length ? JSON.stringify(got[0]) : '');
});

/* ---- items going missing ----------------------------------------------- */

function batch(nodeDef, inCount, outCount) {
  const mk = n => Array.from({ length: n }, (_, i) => ({ json: { id: i, email: 'x' + i + '@y.com' } }));
  return exec(
    [{ name: 'Source', type: 'n8n-nodes-base.code' }, nodeDef],
    {
      Source: [{ executionIndex: 0, data: { main: [mk(inCount)] } }],
      [nodeDef.name]: [{ executionIndex: 1, source: [{ previousNode: 'Source' }],
                         data: { main: [mk(outCount)] } }]
    },
    { Source: { main: [[{ node: nodeDef.name, type: 'main', index: 0 }]] } }
  );
}

const HTTP = { name: 'Enrich', type: 'n8n-nodes-base.httpRequest' };
let loss = E.itemLoss(batch(HTTP, 50, 47));
check('an HTTP node that returned 47 of 50 is reported',
  loss.length === 1 && loss[0].lost === 3,
  loss.length ? JSON.stringify(loss[0]) : 'nothing');

check('an HTTP node that returned all 50 is not',
  E.itemLoss(batch(HTTP, 50, 50)).length === 0);

check('an HTTP node that returned more is not',
  E.itemLoss(batch(HTTP, 5, 8)).length === 0);

// The false positive that would make this useless: a Code node in its default
// mode legitimately turns fifty items into one summary row.
const CODE_ALL = { name: 'Summarise', type: 'n8n-nodes-base.code', parameters: {} };
check('a Code node aggregating 50 into 1 is NOT called data loss',
  E.itemLoss(batch(CODE_ALL, 50, 1)).length === 0,
  JSON.stringify(E.itemLoss(batch(CODE_ALL, 50, 1))));

const CODE_EACH = { name: 'Map', type: 'n8n-nodes-base.code',
                    parameters: { mode: 'runOnceForEachItem' } };
loss = E.itemLoss(batch(CODE_EACH, 50, 48));
check('but a per-item Code node dropping 2 IS reported',
  loss.length === 1 && loss[0].lost === 2, JSON.stringify(loss[0] || null));

check('a Filter is never judged for losing items',
  E.itemLoss(batch({ name: 'Only New', type: 'n8n-nodes-base.filter' }, 50, 3)).length === 0);

check('a node with no upstream input is not judged',
  E.itemLoss(exec([HTTP], { Enrich: [{ executionIndex: 0, data: { main: [[]] } }] })).length === 0);

/* ---- robustness -------------------------------------------------------- */

let threw = false;
try { E.errorPayloads(httpRun(JSON.parse('{"__proto__":{"error":"x"},"a":1}'))); }
catch (e) { threw = true; }
check('a __proto__ field neither throws nor pollutes', !threw && ({}).error === undefined);

check('an execution with no data at all is handled',
  E.errorPayloads({ data: {} }).length === 0 && E.itemLoss({ data: {} }).length === 0);

console.log('\n  ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
