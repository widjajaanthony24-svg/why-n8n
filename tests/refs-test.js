// Expressions pointing at fields that aren't there.
//
// {{ $json.customer.email }} against input with no `customer` resolves to
// nothing. No error, node runs, field goes out blank, run is green. Rename a
// field upstream and a workflow quietly writes empty values into a CRM.
//
// The precision bar is high because expressions are everywhere. A false
// positive here means shouting about a working workflow, so most of these
// cases are the ones it must NOT flag.
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}
const shows = r => r.map(b => b.param + ': ' + b.expr + ' → no "' + b.missing + '" in ' + b.where).join('; ') || 'nothing';

// Source → Target. Target's parameters carry the expressions under test.
function build(params, sourceItems, extra) {
  const rd = {
    Source: [{ executionIndex: 0, data: { main: [sourceItems.map(j => ({ json: j }))] } }],
    Target: [{ executionIndex: 1, source: [{ previousNode: 'Source' }],
               data: { main: [[{ json: { done: true } }]] } }]
  };
  const nodes = [{ name: 'Source', type: 'n8n-nodes-base.code' },
                 { name: 'Target', type: 'n8n-nodes-base.httpRequest', parameters: params }];
  const connections = { Source: { main: [[{ node: 'Target', type: 'main', index: 0 }]] } };
  if (extra) {
    rd[extra.name] = [{ executionIndex: 2, data: { main: [extra.items.map(j => ({ json: j }))] } }];
    nodes.push({ name: extra.name, type: 'n8n-nodes-base.code' });
  }
  return { id: '1', workflowId: 'WF1', status: 'success',
           workflowData: { nodes, connections },
           data: { resultData: { runData: rd } } };
}

const LEAD = [{ lead: { email: 'a@b.com', name: 'Marcus' }, id: 7 }];

/* ---- must flag --------------------------------------------------------- */

let r = E.brokenRefs(build({ url: '={{ $json.customer.email }}' }, LEAD), 'Target');
check('a top-level key that does not exist',
  r.length === 1 && r[0].missing === 'customer', shows(r));

r = E.brokenRefs(build({ url: '={{ $json.lead.phone }}' }, LEAD), 'Target');
check('a nested key that does not exist, naming the parent that does',
  r.length === 1 && r[0].missing === 'phone' && r[0].where === 'lead', shows(r));

r = E.brokenRefs(build({ url: '={{ $json["customer"]["email"] }}' }, LEAD), 'Target');
check('bracket syntax is understood too',
  r.length === 1 && r[0].missing === 'customer', shows(r));

r = E.brokenRefs(
  build({ url: "={{ $('Enrich').item.json.company.domain }}" }, LEAD,
        { name: 'Enrich', items: [{ company: { name: 'Northgate' } }] }), 'Target');
check('a cross-node reference is resolved against THAT node',
  r.length === 1 && r[0].missing === 'domain', shows(r));

// Missing on every item, not just the first.
r = E.brokenRefs(build({ url: '={{ $json.lead.phone }}' },
  [{ lead: { email: 'a@b.com' } }, { lead: { email: 'c@d.com' } }]), 'Target');
check('flagged when absent from every item', r.length === 1, shows(r));

/* ---- must stay silent -------------------------------------------------- */

r = E.brokenRefs(build({ url: '={{ $json.lead.email }}' }, LEAD), 'Target');
check('a reference that resolves', r.length === 0, shows(r));

// The one that matters most: present on SOME items is normal, not a fault.
r = E.brokenRefs(build({ url: '={{ $json.lead.phone }}' },
  [{ lead: { email: 'a@b.com' } }, { lead: { email: 'c@d.com', phone: '123' } }]), 'Target');
check('resolves on at least one item → not a fault', r.length === 0, shows(r));

const fallbacks = [
  ['|| default', "={{ $json.customer.email || 'none' }}"],
  ['?? default', '={{ $json.customer.email ?? "none" }}'],
  ['optional chaining', '={{ $json.customer?.email }}'],
  ['a ternary', '={{ $json.customer ? $json.customer.email : "" }}'],
  ['an if()', '={{ if($json.customer, $json.customer.email, "") }}']
];
fallbacks.forEach(([label, expr]) => {
  const got = E.brokenRefs(build({ url: expr }, LEAD), 'Target');
  check('silent when the author handled absence with ' + label, got.length === 0, shows(got));
});

r = E.brokenRefs(build({ url: '={{ $json }}' }, LEAD), 'Target');
check('$json on its own is not a path', r.length === 0, shows(r));

r = E.brokenRefs(build({ url: 'https://example.com/static' }, LEAD), 'Target');
check('a plain string with no expression', r.length === 0, shows(r));

// No input stored means the check cannot run - and must not pretend it did.
const noInput = build({ url: '={{ $json.customer.email }}' }, []);
check('says nothing when there is no input to check against',
  E.brokenRefs(noInput, 'Target').length === 0, shows(E.brokenRefs(noInput, 'Target')));

r = E.brokenRefs(build({ url: "={{ $('Nowhere').item.json.a.b }}" }, LEAD), 'Target');
check('a reference to a node that never ran is not guessed at', r.length === 0, shows(r));

/* ---- whole-execution sweep --------------------------------------------- */

const wf = build({ url: '={{ $json.customer.email }}', body: '={{ $json.lead.phone }}' }, LEAD);
const all = E.allBrokenRefs(wf);
check('the sweep finds both broken parameters and names the node',
  all.length === 2 && all.every(b => b.node === 'Target'), shows(all));

/* ---- robustness -------------------------------------------------------- */

let threw = false;
try {
  E.brokenRefs(build({ url: '={{ $json.__proto__.x }}' }, LEAD), 'Target');
} catch (e) { threw = true; }
check('a __proto__ path neither throws nor pollutes', !threw && ({}).x === undefined);

threw = false;
try {
  let deep = '$json'; for (let i = 0; i < 500; i++) deep += '.a';
  E.brokenRefs(build({ url: '={{ ' + deep + ' }}' }, LEAD), 'Target');
} catch (e) { threw = true; }
check('an absurdly deep path does not crash', !threw);

console.log('\n  ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
