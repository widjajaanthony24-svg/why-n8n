const path = require('path');
// Adversarial pass. The threat model: an n8n workflow is not trusted input.
// People import community templates constantly, and shared workspaces mean
// someone else authored the node you are debugging. Everything reachable from
// workflowData or from a node's output payload is attacker-controlled.
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

/* 1. Prototype pollution through payload keys ------------------------- */
{
  const polluted = () => ({}).seen !== undefined || ({}).polluted !== undefined;
  let profile = null;
  for (let i = 0; i < 10; i++) profile = E.addToProfile(profile, { ok: 'x'.repeat(40) });
  try { profile = E.addToProfile(profile, JSON.parse('{"__proto__":{"polluted":true},"ok":"y"}')); }
  catch (e) { /* throwing is an acceptable outcome; polluting is not */ }
  check('payload key "__proto__" does not pollute Object.prototype', !polluted(),
    polluted() ? 'Object.prototype.seen = ' + JSON.stringify({}.seen) : '');
}

/* 2. Prototype pollution through payload VALUES (used as map keys) ---- */
{
  let profile = null;
  for (let i = 0; i < 10; i++) profile = E.addToProfile(profile, { tier: 'gold' });
  try { profile = E.addToProfile(profile, { tier: '__proto__' }); } catch (e) { /* ok */ }
  check('payload value "__proto__" does not pollute', ({}).seen === undefined);
}

/* 3. Replay must never escape /webhook/ ------------------------------- */
{
  const hostile = (path, method) => ({
    workflowData: {
      nodes: [{ name: 'Hook', type: 'n8n-nodes-base.webhook', parameters: { path, httpMethod: method } }],
      connections: {}
    },
    data: { resultData: { runData: { Hook: [{ executionIndex: 0, data: { main: [[{ json: { body: { a: 1 } } }]] } }] } } }
  });

  const cases = [
    ['../rest/workflows', 'DELETE'],
    ['..%2Frest%2Fworkflows', 'POST'],
    ['../../rest/users', 'PUT'],
    ['a/../../rest/login', 'POST']
  ];
  let escaped = [];
  cases.forEach(([p, m]) => {
    const t = E.replayTarget(hostile(p, m), 'https://n8n.example.com');
    if (!t) return;
    let pathname;
    try { pathname = new URL(t.url).pathname; } catch (e) { pathname = t.url; }
    if (pathname.indexOf('/webhook/') !== 0) escaped.push(m + ' ' + t.url + '  -> ' + pathname);
  });
  check('a hostile webhook path cannot retarget replay at the n8n API',
    escaped.length === 0, escaped.join('\n          '));

  // DELETE is a legitimate n8n webhook verb, so it is preserved - the URL check
  // above is what makes that safe. An unrecognised verb must not pass through.
  const t2 = E.replayTarget(hostile('normal-hook', 'DELETE'), 'https://n8n.example.com');
  check('a real webhook still replays with its own verb', t2 && t2.method === 'DELETE');

  const t3 = E.replayTarget(hostile('normal-hook', 'TRACE'), 'https://n8n.example.com');
  check('an unrecognised verb falls back to POST', t3 && t3.method === 'POST',
    t3 ? 'method = ' + t3.method : 'no target');

  const t4 = E.replayTarget(hostile('hook?x=1#y', 'POST'), 'https://n8n.example.com');
  check('a path carrying a query or fragment is refused', t4 === null);

  const t5 = E.replayTarget(hostile('//evil.example.com/x', 'POST'), 'https://n8n.example.com');
  check('a protocol-relative path cannot leave the origin',
    t5 === null || new URL(t5.url).origin === 'https://n8n.example.com',
    t5 ? t5.url : 'refused');
}

/* 6. A node literally named __proto__ ---------------------------------- */
{
  const exec = JSON.parse(JSON.stringify({
    workflowData: { nodes: [{ name: '__proto__', type: 'n8n-nodes-base.code' }], connections: {} },
    data: { resultData: { runData: { __proto__: [{ executionIndex: 0, data: { main: [[]] } }] } } }
  }));
  let ok = true, err = '';
  try { E.verdict(exec); } catch (e) { ok = false; err = e.message; }
  check('a node named __proto__ does not crash or pollute', ok && ({}).seen === undefined, err);
}

/* 7. A node type named __proto__ must not read back the prototype ------ */
{
  const exec = {
    workflowData: { nodes: [{ name: 'X', type: '__proto__' }], connections: { W: { main: [[{ node: 'X', type: 'main', index: 0 }]] } } },
    data: { resultData: { runData: { X: [{ executionIndex: 0, data: { main: [[]] } }] } } }
  };
  const v = E.verdict(exec);
  check('a node type of __proto__ is not treated as a reducer',
    v && v.kind === 'silent', v ? v.kind + ': ' + v.text : 'no verdict');
}

/* 4. Deeply nested payload must not blow the stack -------------------- */
{
  let deep = { end: true };
  for (let i = 0; i < 60000; i++) deep = { n: deep };
  const exec = {
    workflowData: { nodes: [{ name: 'A', type: 'n8n-nodes-base.code' }, { name: 'B', type: 'n8n-nodes-base.code' }],
      connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } } },
    data: { resultData: { runData: {
      A: [{ executionIndex: 0, data: { main: [[{ json: deep }]] } }],
      B: [{ executionIndex: 1, data: { main: [[]] } }]
    } } }
  };
  let ok = true, err = '';
  try { E.verdict(exec); } catch (e) { ok = false; err = e.message; }
  check('a 60k-deep payload does not crash the scan', ok, err);
}

/* 5. Huge fan-out payload must stay bounded --------------------------- */
{
  const wide = {};
  for (let i = 0; i < 50000; i++) wide['f' + i] = 'v' + i;
  const t0 = Date.now();
  let profile = null;
  for (let i = 0; i < 10; i++) profile = E.addToProfile(profile, wide);
  const ms = Date.now() - t0;
  check('a 50k-field payload does not stall profiling', ms < 2000, ms + 'ms');
  check('profile does not retain 50k fields per run',
    Object.keys(profile.fields).length <= 64, Object.keys(profile.fields).length + ' fields kept');
}

console.log('\n  ' + pass + '/' + total + ' passed');
