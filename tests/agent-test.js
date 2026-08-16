// n8n AI Agent nodes, which are the ones this product is actually aimed at.
//
// The structure that matters: an Agent is a "root node" and its language
// model, tools and memory hang off it as SUB-nodes, connected by channels
// like ai_tool rather than main. Their output is stored on those channels
// too. An agent's real context therefore never appears on its main input.
//
// Output shape is { output, intermediateSteps } - the steps only present when
// "Return Intermediate Steps" is enabled, which is off by default.
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

// Chat Trigger -> AI Agent, with a CRM lookup tool and a chat model attached
// as sub-nodes. Mirrors what n8n stores for a tool-using agent.
function agentExec(opts) {
  opts = opts || {};
  const rd = {
    'When chat message received': [
      { executionIndex: 0, data: { main: [[{ json: { chatInput: 'What is Northgate Legal\'s account number?' } }]] } }
    ],
    'AI Agent': [
      { executionIndex: 1, source: [{ previousNode: 'When chat message received' }],
        data: { main: [[{ json: opts.output }]] } }
    ]
  };

  if (!opts.noTool) {
    rd['Lookup CRM'] = [{
      executionIndex: 2,
      data: {
        ai_tool: [[{ json: {
          response: 'Northgate Legal — account ACC-88421905, switchboard +44 161 555 0123'
        } }]]
      }
    }];
  }
  rd['OpenAI Chat Model'] = [{ executionIndex: 3, data: { ai_languageModel: [[{ json: { tokens: 812 } }]] } }];

  const connections = {
    'When chat message received': { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
    'OpenAI Chat Model': { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] }
  };
  if (!opts.noTool) {
    connections['Lookup CRM'] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
  }

  return {
    workflowData: {
      nodes: [
        { name: 'When chat message received', type: '@n8n/n8n-nodes-langchain.chatTrigger' },
        { name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent' },
        { name: 'Lookup CRM', type: '@n8n/n8n-nodes-langchain.toolWorkflow' },
        { name: 'OpenAI Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi' }
      ],
      connections
    },
    status: 'success',
    data: { resultData: { runData: rd, lastNodeExecuted: 'AI Agent' } }
  };
}

/* ---- parsing ----------------------------------------------------------- */

const ok = agentExec({ output: { output: 'The account number is ACC-88421905.' } });

check('the agent, not a sub-node, is treated as the result',
  E.resultNode(ok) === 'AI Agent', 'got ' + E.resultNode(ok));

check('a healthy agent run is not reported as broken',
  E.verdict(ok) === null, JSON.stringify(E.verdict(ok)));

check('sub-nodes are found through their non-main channels',
  E.helpersOf(ok, 'AI Agent').length === 2,
  E.helpersOf(ok, 'AI Agent').map(h => h.name + ':' + h.type).join(', '));

/* ---- provenance, the part that would have been badly wrong ------------- */

// The account number and phone came back from the TOOL, not from the main
// input. Before sub-node context was included, every one of these would have
// been reported as invented - i.e. every RAG agent, on every run.
const fromTool = agentExec({
  output: { output: 'Northgate Legal is account ACC-88421905, reachable on 0161 555 0123.' }
});
check('facts retrieved by a tool are NOT called inventions',
  E.provenance(fromTool, 'AI Agent').length === 0,
  E.provenance(fromTool, 'AI Agent').map(c => c.kind + ' ' + c.full).join('; '));

const invented = agentExec({
  output: { output: 'Their account is ACC-77310244 and billing is at billing@northgate-invoices.net.' }
});
const found = E.provenance(invented, 'AI Agent');
check('a number no tool ever returned IS flagged',
  found.some(c => c.kind === 'number' && c.value === '77310244'),
  found.map(c => c.kind + ' ' + c.full).join('; ') || 'nothing flagged');
check('an email domain no tool ever returned IS flagged',
  found.some(c => c.kind === 'email domain' && /northgate-invoices/.test(c.value)),
  found.map(c => c.kind + ' ' + c.full).join('; ') || 'nothing flagged');

// Observations inside intermediateSteps are retrieved context too.
const viaSteps = agentExec({
  noTool: true,
  output: {
    output: 'The switchboard is +44 161 555 0123.',
    intermediateSteps: [{
      action: { tool: 'Lookup CRM', toolInput: { name: 'Northgate Legal' } },
      observation: 'switchboard +44 161 555 0123'
    }]
  }
});
check('facts drawn from intermediateSteps are not called inventions',
  E.provenance(viaSteps, 'AI Agent').length === 0,
  E.provenance(viaSteps, 'AI Agent').map(c => c.full).join('; '));

/* ---- the backwards trace ----------------------------------------------- */

const trace = E.agentTrace(viaSteps, 'AI Agent');
check('the trace names the tool that was called',
  trace.some(s => s.tool === 'Lookup CRM' && s.from === 'step'),
  JSON.stringify(trace[0] || null));
check('and carries what the tool sent back',
  trace.some(s => /555 0123/.test(String(s.output))));

// The common case: Return Intermediate Steps is OFF, so the steps are absent.
// The trace has to work from the sub-nodes' own stored runs instead.
const noSteps = E.agentTrace(agentExec({ output: { output: 'Done.' } }), 'AI Agent');
check('still traces the tool when intermediateSteps is switched off',
  noSteps.some(s => s.from === 'node' && s.tool === 'Lookup CRM'),
  noSteps.map(s => s.from + ':' + s.tool).join(', ') || 'empty');
check('and labels what kind of sub-node each was',
  noSteps.some(s => s.kind === 'tool') && noSteps.some(s => s.kind === 'languageModel'),
  noSteps.map(s => s.tool + '=' + s.kind).join(', '));

/* ---- an agent that produced nothing ------------------------------------ */

const empty = agentExec({ output: {} });
const v = E.verdict(empty);
check('an agent that returned an empty object is reported',
  v && v.kind === 'silent', v ? v.text : 'no verdict');

/* ---- drift on the agent's answer field --------------------------------- */

let profile = null;
for (let i = 0; i < 10; i++) {
  profile = E.addToProfile(profile, {
    output: 'Northgate Legal is a 45-person commercial property firm in Manchester, '
          + 'account ACC-88421905. Run ' + i + '.'
  });
}
const refusal = E.driftAgainst(profile, { output: "I'm sorry, I can't help with that." });
check('a refusal in the agent answer field is caught as drift',
  refusal.some(d => d.field === 'output' && d.kind === 'shrank'),
  refusal.map(d => d.field + ' ' + d.kind).join('; ') || 'no drift');

console.log('\n  ' + pass + '/' + total + ' passed');
