/* Builds the n8n-native watcher workflow.
 *
 *   node build-watcher.js
 *
 * The detection engine is INLINED from engine.js rather than
 * reimplemented, so the workflow and the extension can never disagree about
 * what counts as a failure. Re-run this after any engine change.
 *
 * Why a workflow at all: a browser extension stops the moment the browser
 * does, and MV3 service workers cannot outlive Chrome. n8n itself is already
 * running around the clock, so the only thing on the customer's machine that
 * can watch n8n overnight is n8n.
 */
const fs = require('fs');
const path = require('path');

const engine = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');

/* ---------- the analysis that runs every 15 minutes ---------- */

const analyse = `
/* ---- what to look at, and where to shout ---------------------------- */

const E = globalThis.WHY_ENGINE;
const cfg = $('Settings').first().json;

// Survives between runs. This is what lets shape drift work at all: the
// profile of "normal" is built over days, not over one poll.
const memory = $getWorkflowStaticData('global');
memory.profiles = memory.profiles || {};
memory.counts = memory.counts || {};

const MAX_PROFILE_KEYS = 200;
const findings = [];

for (const item of $input.all()) {
  const raw = item.json;
  const exec = E.normalise(raw && raw.data !== undefined ? raw : raw);
  if (!exec || !exec.data || !exec.data.resultData) continue;

  const wf = (exec.workflowData && exec.workflowData.name) || exec.workflowId || 'workflow';
  const id = exec.id;

  // 1. Reported success, produced nothing useful.
  const v = E.verdict(exec);
  if (v && v.kind !== 'filtered') {
    const key = String(exec.workflowId) + '|' + String(v.node);
    memory.counts[key] = (memory.counts[key] || 0) + 1;
    findings.push({
      kind: v.kind === 'error' ? 'failed' : 'produced nothing',
      workflow: wf, execution: id, detail: v.text, seenBefore: memory.counts[key] - 1
    });
    continue;
  }
  if (v) continue;                         // filtered - the workflow working

  const node = E.resultNode(exec);
  if (!node) continue;
  const items = E.resultItems(exec, node);
  const sample = (items && items.length) ? items[0].json : null;

  // 2. Details that appear nowhere in what the node was given.
  const invented = E.provenance(exec, node);
  if (invented.length) {
    findings.push({
      kind: 'invented details', workflow: wf, execution: id,
      detail: invented.map(c => c.field + ': ' + c.full + ' (' + c.kind + ')').join(', ')
    });
  }

  // 3. Output that no longer matches what this node normally produces.
  if (sample) {
    const pkey = String(exec.workflowId) + '|' + node;
    const prof = memory.profiles[pkey];
    if (prof) {
      const drift = E.driftAgainst(prof, sample);
      if (drift.length) {
        findings.push({
          kind: 'output changed shape', workflow: wf, execution: id,
          detail: drift.slice(0, 3)
            .map(d => d.field + ' ' + d.kind + ' - was ' + d.was + ', now ' + d.now).join(' | '),
          baseline: prof.runs
        });
      }
    }
    // Learn from it either way. A profile that only ever absorbs perfect runs
    // freezes, and then flags every legitimate change to the workflow.
    if (prof || Object.keys(memory.profiles).length < MAX_PROFILE_KEYS) {
      memory.profiles[pkey] = E.addToProfile(prof || null, sample);
    }
  }
}

if (!findings.length) return [];

/* ---- one message, not one per finding ------------------------------- */

const lines = findings.slice(0, 12).map(f => {
  const age = f.seenBefore ? '  (seen ' + f.seenBefore + 'x before)' : '';
  const base = f.baseline ? '  (vs ' + f.baseline + ' previous runs)' : '';
  return '• [' + f.kind + '] ' + f.workflow + ' #' + f.execution + age + base + '\\n    ' + f.detail;
});
if (findings.length > 12) lines.push('• …and ' + (findings.length - 12) + ' more');

const text = 'why? found ' + findings.length + ' run'
  + (findings.length === 1 ? '' : 's') + ' worth looking at\\n\\n' + lines.join('\\n')
  + '\\n\\n' + cfg.n8nBaseUrl + '/home/executions';

// content = Discord, text = Slack. Sending both means one webhook field works
// for either without the user having to know which.
return [{ json: { text: text, content: text, findingCount: findings.length } }];
`.trim();

const pickNew = `
/* Only fetch detail for executions this workflow has not already judged.
 * A quiet instance therefore costs exactly one API call per poll. */
const memory = $getWorkflowStaticData('global');
const cfg = $('Settings').first().json;

const rows = ($input.first().json.data || []).filter(
  r => r.status === 'success' || r.status === 'error' || r.status === 'crashed'
);
if (!rows.length) return [];

const ids = rows.map(r => Number(r.id) || 0);
const highest = Math.max(...ids, Number(memory.watermark || 0));

// First ever run: take the mark and stay quiet. Announcing a week-old backlog
// as though it just happened is how an alert channel gets muted on day one.
if (!memory.watermark) {
  memory.watermark = highest;
  return [];
}

const fresh = rows
  .filter(r => (Number(r.id) || 0) > Number(memory.watermark))
  .slice(0, 15);

memory.watermark = highest;
return fresh.map(r => ({ json: { id: r.id, baseUrl: cfg.n8nBaseUrl } }));
`.trim();

const settings = `
/* ------------------------------------------------------------------ *
 *  THE ONLY TWO THINGS YOU NEED TO EDIT
 * ------------------------------------------------------------------ */

// Your n8n's address, no trailing slash.
const n8nBaseUrl = 'https://CHANGE-ME.app.n8n.cloud';

// Where alerts go. A Slack incoming webhook or a Discord webhook - both work,
// the message is sent in a shape either will accept.
const alertWebhookUrl = 'https://CHANGE-ME';

/* ------------------------------------------------------------------ */

return [{ json: { n8nBaseUrl, alertWebhookUrl } }];
`.trim();

/* ---------- the workflow ---------- */

const wf = {
  name: 'why? — watch this n8n',
  nodes: [
    {
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } },
      id: 'w1000000-0000-4000-8000-000000000001',
      name: 'Every 15 minutes',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 0]
    },
    {
      parameters: { jsCode: settings },
      id: 'w1000000-0000-4000-8000-000000000002',
      name: 'Settings',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [200, 0]
    },
    {
      parameters: {
        method: 'GET',
        url: '={{ $json.n8nBaseUrl }}/api/v1/executions?limit=20',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'n8nApi',
        options: { timeout: 15000 }
      },
      id: 'w1000000-0000-4000-8000-000000000003',
      name: 'List recent runs',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [400, 0]
    },
    {
      parameters: { jsCode: pickNew },
      id: 'w1000000-0000-4000-8000-000000000004',
      name: 'Only what is new',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [600, 0]
    },
    {
      parameters: {
        method: 'GET',
        url: '={{ $json.baseUrl }}/api/v1/executions/{{ $json.id }}?includeData=true',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'n8nApi',
        options: { timeout: 20000 }
      },
      id: 'w1000000-0000-4000-8000-000000000005',
      name: 'Fetch each run',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [800, 0]
    },
    {
      parameters: { mode: 'runOnceForAllItems', jsCode: engine + '\n\n' + analyse },
      id: 'w1000000-0000-4000-8000-000000000006',
      name: 'why? engine',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1000, 0]
    },
    {
      parameters: {
        method: 'POST',
        url: '={{ $(\'Settings\').first().json.alertWebhookUrl }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ text: $json.text, content: $json.content }) }}',
        options: { timeout: 15000 }
      },
      id: 'w1000000-0000-4000-8000-000000000007',
      name: 'Tell me',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1200, 0]
    }
  ],
  connections: {
    'Every 15 minutes': { main: [[{ node: 'Settings', type: 'main', index: 0 }]] },
    'Settings': { main: [[{ node: 'List recent runs', type: 'main', index: 0 }]] },
    'List recent runs': { main: [[{ node: 'Only what is new', type: 'main', index: 0 }]] },
    'Only what is new': { main: [[{ node: 'Fetch each run', type: 'main', index: 0 }]] },
    'Fetch each run': { main: [[{ node: 'why? engine', type: 'main', index: 0 }]] },
    'why? engine': { main: [[{ node: 'Tell me', type: 'main', index: 0 }]] }
  },
  settings: {
    executionOrder: 'v1',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'none',   // do not fill their log with our own polls
    saveManualExecutions: true,
    executionTimeout: 120
  }
};

// Ships inside the repo root alongside the extension, so one download carries
// both halves and the test suite can cover it.
const out = path.join(__dirname, 'watcher', 'why-watch-n8n.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(wf, null, 2));

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log('  built ' + path.relative(__dirname, out) + '  (' + kb + ' KB)');
console.log('  engine inlined: ' + (engine.length / 1024).toFixed(1) + ' KB from engine.js');
