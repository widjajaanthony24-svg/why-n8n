// Background watching: the poll that puts a count on the toolbar icon.
//
// The failure that matters here is a red badge full of things the user
// already knows about. A tool that greets a fresh install with "17 problems!"
// - all of them from last week - gets removed the same minute.
const fs = require('fs');
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const m = src.match(/async function pollOrigin\(origin, state\)[\s\S]*?\n\}/);
if (!m) { console.log('could not extract pollOrigin'); process.exit(1); }

const DONE = { success: true, error: true, crashed: true };
const rowsOf = raw => (Array.isArray(raw) ? raw : (raw && raw.data) || []);
const MAX_DETAIL_PER_POLL = 10;

// A tiny fake n8n. Every request is counted, because poll cost is a design
// constraint: a quiet instance must cost one request.
let requests = [];
function makeApi(store) {
  return async function apiGet(origin, p) {
    requests.push(p);
    if (/\/rest\/executions\?/.test(p)) {
      return { data: store.list };
    }
    const id = decodeURIComponent(p.split('/rest/executions/')[1].split('?')[0]);
    if (store.broken && store.broken.indexOf(id) !== -1) throw new Error('HTTP 500');
    return store.detail[id];
  };
}

function exec(id, opts) {
  opts = opts || {};
  const out = opts.empty ? [] : [{ json: { ok: true } }];
  return {
    id: id, workflowId: 'WF1', status: 'success',
    workflowData: {
      nodes: [{ name: 'Build', type: opts.filterNode ? 'n8n-nodes-base.filter' : 'n8n-nodes-base.code' }],
      connections: { Trigger: { main: [[{ node: 'Build', type: 'main', index: 0 }]] } }
    },
    data: { resultData: { runData: {
      Trigger: [{ executionIndex: 0, data: { main: [[{ json: { a: 1 } }]] } }],
      Build: [{ executionIndex: 1, source: [{ previousNode: 'Trigger' }], data: { main: [out] } }]
    } } }
  };
}

function scenario(spec) {
  const detail = {};
  spec.forEach(s => { detail[s.id] = exec(s.id, s); });
  return {
    list: spec.map(s => ({ id: s.id, status: 'success' })),
    detail
  };
}

async function poll(store, state) {
  requests = [];
  const fn = new Function('apiGet', 'rowsOf', 'DONE', 'E', 'MAX_DETAIL_PER_POLL',
    'return ' + m[0])(makeApi(store), rowsOf, DONE, E, MAX_DETAIL_PER_POLL);
  return fn('https://n8n.test', state || {});
}

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

(async function () {
  // Three broken runs already sitting there when the user first switches it on.
  const backlog = scenario([{ id: '30', empty: true }, { id: '29', empty: true }, { id: '28', empty: true }]);

  let r = await poll(backlog, {});
  check('a fresh instance reports nothing, however bad the backlog', r.count === 0,
    'count=' + r.count);
  check('but it does take the high-water mark', r.mark === 30, 'mark=' + r.mark);
  check('and costs exactly one request to do it', requests.length === 1,
    requests.length + ' requests: ' + requests.join(', '));

  // Nothing new since.
  r = await poll(backlog, { watermarks: { 'https://n8n.test': 30 } });
  check('a quiet instance stays quiet and still costs one request',
    r.count === 0 && requests.length === 1, 'count=' + r.count + ', ' + requests.length + ' requests');

  // Two new broken runs arrive.
  const fresh = scenario([{ id: '32', empty: true }, { id: '31', empty: true },
                          { id: '30', empty: true }]);
  r = await poll(fresh, { watermarks: { 'https://n8n.test': 30 } });
  check('counts only what arrived since the last check', r.count === 2, 'count=' + r.count);
  check('and only fetches detail for those two', requests.length === 3,
    requests.length + ' requests');
  check('advances the mark', r.mark === 32, 'mark=' + r.mark);

  // A Filter emptying is the workflow working - it must never reach the badge.
  const filtered = scenario([{ id: '33', empty: true, filterNode: true }]);
  r = await poll(filtered, { watermarks: { 'https://n8n.test': 32 } });
  check('a Filter that kept nothing does not count as a finding', r.count === 0,
    'count=' + r.count);

  // Healthy runs.
  const healthy = scenario([{ id: '34' }, { id: '35' }]);
  r = await poll(healthy, { watermarks: { 'https://n8n.test': 33 } });
  check('healthy runs do not count', r.count === 0, 'count=' + r.count);

  // Muted faults stay muted in the background too.
  const muted = scenario([{ id: '36', empty: true }]);
  r = await poll(muted, { watermarks: { 'https://n8n.test': 35 }, ignored: ['WF1|Build'] });
  check('the ignore list is honoured by the background check too', r.count === 0,
    'count=' + r.count);

  // One unreadable execution must not abort the whole poll.
  const partly = scenario([{ id: '38', empty: true }, { id: '37', empty: true }]);
  partly.broken = ['37'];
  r = await poll(partly, { watermarks: { 'https://n8n.test': 36 } });
  check('one unreadable run does not lose the other finding', r.count === 1,
    'count=' + r.count);
  check('and the mark still advances past both', r.mark === 38, 'mark=' + r.mark);

  console.log('\n  ' + pass + '/' + total + ' passed');
  if (pass !== total) process.exit(1);
})();
