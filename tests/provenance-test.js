// Provenance: claims in a node's output that appear nowhere in its input.
//
// The bar here is asymmetric. Missing a fabrication is a shame; flagging a
// legitimate one is fatal - an enrichment step that composes an email address
// from parts it was given is doing its job, and a tool that calls that a
// hallucination gets uninstalled the same day. Most of these cases are
// therefore negatives.
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

// Two nodes: "Context" feeds "Agent". Provenance compares Agent's output
// against everything Context handed it.
function run(inputJson, outputJson, opts) {
  opts = opts || {};
  const rd = {
    Agent: [{ executionIndex: 1, data: { main: [[{ json: outputJson }]] } }]
  };
  if (!opts.noInput) {
    rd.Context = [{ executionIndex: 0, data: { main: [[{ json: inputJson }]] } }];
  }
  return E.provenance({
    workflowData: {
      nodes: [{ name: 'Context', type: 'n8n-nodes-base.code' },
              { name: 'Agent', type: '@n8n/n8n-nodes-langchain.agent' }],
      connections: { Context: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] } }
    },
    data: { resultData: { runData: rd } }
  }, 'Agent');
}

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}
const shows = r => r.map(c => c.kind + ' "' + c.value + '" in ' + (c.field || 'output')).join('; ') || 'nothing flagged';

const ctx = {
  company: 'Northgate Legal',
  website: 'https://northgatelegal.co.uk/about',
  contact: 'marcus.whitfield@northgatelegal.co.uk',
  switchboard: '+44 161 555 0123',
  account_ref: 'ACC-88421905',
  notes: 'A 45-person firm in Manchester specialising in commercial property.'
};

/* ---- must stay silent -------------------------------------------------- */

check('email copied straight from the input',
  run(ctx, { email: 'marcus.whitfield@northgatelegal.co.uk' }).length === 0);

check('email COMPOSED from a name and a domain that were both given',
  run(ctx, { email: 'm.whitfield@northgatelegal.co.uk' }).length === 0,
  shows(run(ctx, { email: 'm.whitfield@northgatelegal.co.uk' })));

check('phone reformatted from +44 161 555 0123 to 441615550123',
  run(ctx, { phone: '441615550123' }).length === 0);

check('phone rewritten with different punctuation',
  run(ctx, { phone: '(0161) 555-0123' }).length === 0,
  shows(run(ctx, { phone: '(0161) 555-0123' })));

check('link to a page on a domain that was given',
  run(ctx, { source: 'https://northgatelegal.co.uk/team' }).length === 0);

check('a paraphrased summary carrying no hard specifics',
  run(ctx, { summary: 'A mid-sized commercial property firm based in Manchester.' }).length === 0);

check('a small computed number - a total, a count, a year',
  run(ctx, { headcount: 45, total: '450.00', year: '2026' }).length === 0,
  shows(run(ctx, { headcount: 45, total: '450.00', year: '2026' })));

check('the account reference, copied exactly',
  run(ctx, { ref: 'ACC-88421905' }).length === 0);

check('says nothing at all when there is no input to compare against',
  run(ctx, { phone: '+1 555 987 6543' }, { noInput: true }).length === 0);

/* ---- must flag --------------------------------------------------------- */

const invented = run(ctx, {
  contact_email: 'sales@northgate-legal-group.com',
  summary: 'Reach their intake team on +1 (415) 555-8890.'
});
check('an email domain that appears nowhere in the input',
  invented.some(c => c.kind === 'email domain' && /northgate-legal-group/.test(c.value)),
  shows(invented));
check('a phone number that appears nowhere in the input',
  invented.some(c => c.kind === 'number' && c.value === '14155558890'),
  shows(invented));

const badLink = run(ctx, { citation: 'https://companieshouse-uk-records.com/12345' });
check('a link to a host that was never provided',
  badLink.some(c => c.kind === 'link'), shows(badLink));

const badRef = run(ctx, { invoice_ref: 'INV-77310244' });
check('an identifier the model produced on its own',
  badRef.some(c => c.kind === 'number' && c.value === '77310244'), shows(badRef));

check('names the field the invented claim sits in',
  invented.length > 0 && invented[0].field !== undefined && invented[0].field !== '',
  invented.length ? JSON.stringify(invented[0]) : '');

/* ---- robustness -------------------------------------------------------- */

check('a hostile __proto__ field neither throws nor pollutes', (() => {
  try { run(ctx, JSON.parse('{"__proto__":{"x":1},"a":"b"}')); }
  catch (e) { return false; }
  return ({}).x === undefined;
})());

check('deeply nested output does not crash', (() => {
  let deep = { end: 'https://invented-host-xyz.com/a' };
  for (let i = 0; i < 5000; i++) deep = { n: deep };
  try { run(ctx, deep); } catch (e) { return false; }
  return true;
})());

console.log('\n  ' + pass + '/' + total + ' passed');
