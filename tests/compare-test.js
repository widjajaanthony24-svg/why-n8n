// Run-against-previous-run: the build-loop diff.
//
// The bar is different from every other check here. Drift and provenance must
// be almost silent, because they interrupt. This one is asked for - you hit
// Execute and you WANT to know what moved. So the failure mode to avoid is
// not noise, it is drowning the real change in reworded prose. Anything with
// a model in it rewrites its text on every run; if that fills the list, the
// one field that actually broke is invisible.
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}
const shows = c => c.changes.map(x => x.field + ' ' + x.kind).join(', ') || 'identical';

function run(id, items) {
  return {
    id: id, workflowId: 'WF1', status: 'success',
    workflowData: {
      nodes: [{ name: 'Trigger', type: 'n8n-nodes-base.webhook' },
              { name: 'Build', type: 'n8n-nodes-base.code' }],
      connections: { Trigger: { main: [[{ node: 'Build', type: 'main', index: 0 }]] } }
    },
    data: { resultData: { runData: {
      Trigger: [{ executionIndex: 0, data: { main: [[{ json: { in: 1 } }]] } }],
      Build: [{ executionIndex: 1, source: [{ previousNode: 'Trigger' }],
                data: { main: [items.map(j => ({ json: j }))] } }]
    } } }
  };
}

const base = { name: 'Marcus Whitfield', tier: 'enterprise', confidence: 0.9, headcount: 45 };

/* ---- the useful signals ------------------------------------------------ */

let c = E.compareRuns(run('1', [base]), run('2', [base]));
check('an unchanged run reports identical', c.identical, shows(c));

c = E.compareRuns(run('1', [base]), run('2', [Object.assign({}, base, { tier: 'mid-market' })]));
check('a changed value is named with before and after',
  c.changes.length === 1 && c.changes[0].field === 'tier'
  && /enterprise/.test(c.changes[0].was) && /mid-market/.test(c.changes[0].now),
  JSON.stringify(c.changes[0]));

const gone = Object.assign({}, base); delete gone.confidence;
c = E.compareRuns(run('1', [base]), run('2', [gone]));
check('a field that disappeared is reported as gone',
  c.changes.some(x => x.field === 'confidence' && x.kind === 'gone'), shows(c));

c = E.compareRuns(run('1', [gone]), run('2', [base]));
check('a field that appeared is reported as new',
  c.changes.some(x => x.field === 'confidence' && x.kind === 'new'), shows(c));

c = E.compareRuns(run('1', [base]), run('2', [Object.assign({}, base, { tier: '' })]));
check('a field that went empty is called out specifically',
  c.changes.some(x => x.field === 'tier' && x.kind === 'emptied'), shows(c));

c = E.compareRuns(run('1', [base]), run('2', [Object.assign({}, base, { confidence: 'high' })]));
check('a type flip is reported as a type change',
  c.changes.some(x => x.field === 'confidence' && x.kind === 'type'), shows(c));

// The single most important signal while building: the row count collapsed.
c = E.compareRuns(run('1', [base, base, base]), run('2', [base]));
check('a drop in item count leads the list',
  c.changes[0].kind === 'count' && c.changes[0].was === '3' && c.changes[0].now === '1',
  JSON.stringify(c.changes[0]));

// When the workflow stops producing where it used to, the result node falls
// back to an earlier one. Diffing across two different nodes turns every
// field into "gone" and buries the one fact worth reading.
c = E.compareRuns(run('1', [base]), run('2', []));
check('a workflow that stopped producing reports WHERE it stopped',
  c.nodeMoved && c.changes[0].kind === 'moved' && c.changes[0].was === 'Build',
  JSON.stringify(c.changes[0]));
check('and does not list every field of an unrelated node as gone',
  c.changes.length === 1, shows(c));

/* ---- not drowning the signal in reworded prose ------------------------- */

const long = n => ({
  tier: 'enterprise',
  summary: 'Operations Director at Northgate Legal, a 45-person commercial property firm '
         + 'based in Manchester. Strong fit for the mid-market tier. Variant ' + n + '.'
});

c = E.compareRuns(run('1', [long('A')]), run('2', [long('B')]));
check('a model rewording long prose at the same length is NOT reported',
  c.identical, shows(c));

const collapsed = { tier: 'enterprise', summary: "I'm sorry, I can't help with that." };
c = E.compareRuns(run('1', [long('A')]), run('2', [collapsed]));
check('but prose collapsing to a refusal IS reported, with the text',
  c.changes.some(x => x.field === 'summary' && x.kind === 'shorter' && /sorry/.test(x.now)),
  shows(c));

// Short strings are compared exactly - a status flipping matters even though
// the same edit distance in a summary would not.
c = E.compareRuns(run('1', [{ status: 'paid' }]), run('2', [{ status: 'unpaid' }]));
check('short values are compared exactly',
  c.changes.some(x => x.field === 'status' && x.kind === 'changed'), shows(c));

/* ---- nesting and robustness -------------------------------------------- */

c = E.compareRuns(
  run('1', [{ contact: { email: 'a@b.com', phone: '123' } }]),
  run('2', [{ contact: { email: 'a@b.com', phone: '999' } }]));
check('nested fields are compared by path',
  c.changes.some(x => /phone/.test(x.field) && x.kind === 'changed'), shows(c));

c = E.compareRuns(run('1', []), run('2', []));
check('two empty runs compare without throwing', c.changes.length === 0 || true);

let threw = false;
try { E.compareRuns(run('1', [JSON.parse('{"__proto__":{"x":1},"a":1}')]), run('2', [{ a: 2 }])); }
catch (e) { threw = true; }
check('a __proto__ field neither throws nor pollutes', !threw && ({}).x === undefined);

console.log('\n  ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
