// Which KIND of wrong: hallucinating, bad context, or a wrong decision from
// correct data. The three branches a real user described walking by hand.
//
// Precedence matters as much as detection. If retrieval missed, the resulting
// invented answer is a SYMPTOM - reporting "hallucinated" there sends someone
// to fix the prompt when the bug is in the vector store.
const path = require('path');
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}
const show = d => d ? d.branch + ' — ' + d.why + (d.evidence.length ? '  [' + d.evidence[0] + ']' : '') : 'nothing';

// Chat trigger -> AI Agent, with a lookup tool and a chat model attached.
function build(o) {
  o = o || {};
  const rd = {
    Ask: [{ executionIndex: 0, data: { main: [[{ json: o.ask }]] } }],
    'AI Agent': [{ executionIndex: 1, source: [{ previousNode: 'Ask' }],
      data: { main: [[{ json: o.answer }]] } }]
  };
  const connections = { Ask: { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] } };
  const nodes = [
    { name: 'Ask', type: '@n8n/n8n-nodes-langchain.chatTrigger' },
    { name: 'AI Agent', type: '@n8n/n8n-nodes-langchain.agent' }
  ];

  if (o.tool !== undefined) {
    nodes.push({ name: 'Lookup CRM', type: '@n8n/n8n-nodes-langchain.toolWorkflow' });
    connections['Lookup CRM'] = { ai_tool: [[{ node: 'AI Agent', type: 'ai_tool', index: 0 }]] };
    const run = { executionIndex: 2 };
    if (o.toolError) run.error = { message: 'ECONNREFUSED' };
    else run.data = { ai_tool: [o.tool.map(j => ({ json: j }))] };
    rd['Lookup CRM'] = [run];
  }

  nodes.push({ name: 'Chat Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi' });
  connections['Chat Model'] = { ai_languageModel: [[{ node: 'AI Agent', type: 'ai_languageModel', index: 0 }]] };
  rd['Chat Model'] = [{ executionIndex: 3, data: { ai_languageModel: [[{ json: { tokens: 90 } }]] } }];

  return { status: 'success', workflowData: { nodes, connections },
           data: { resultData: { runData: rd } } };
}

const CRM = [{ account: 'ACC-88421905', company: 'Northgate Legal', tier: 'enterprise',
               headcount: 45, contact: 'marcus@northgatelegal.co.uk' }];

/* ---- branch 1: bad context -------------------------------------------- */

let d = E.diagnose(build({
  ask: { chatInput: 'What tier is account ACC-88421905 on?' },
  tool: [], answer: { output: 'They are on the enterprise tier.' }
}), 'AI Agent');
check('tools returned nothing and it answered anyway → bad context',
  d && d.branch === 'bad context', show(d));

d = E.diagnose(build({
  ask: { chatInput: 'What tier is account ACC-88421905 on?' },
  tool: CRM, toolError: true, answer: { output: 'Enterprise.' }
}), 'AI Agent');
check('a tool that errored → bad context, naming the tool',
  d && d.branch === 'bad context' && /Lookup CRM/.test(d.evidence[0]), show(d));

d = E.diagnose(build({
  ask: { chatInput: 'What is the status of invoice INV-77310?' },
  tool: [{ account: 'ACC-88421905', invoice: 'INV-99001', status: 'paid' }],
  answer: { output: 'Invoice INV-77310 is paid.' }
}), 'AI Agent');
check('retrieval came back about a different record → bad context',
  d && d.branch === 'bad context' && /77310/.test(d.evidence[0]), show(d));

/* ---- branch 2: wrong decision from correct data ------------------------ */

d = E.diagnose(build({
  ask: { chatInput: 'What tier is ACC-88421905?' },
  tool: CRM,
  answer: { account: 'ACC-88421905', tier: 'mid-market' }
}), 'AI Agent');
check('answer contradicts the record it was given → wrong decision',
  d && d.branch === 'wrong decision' && /tier/.test(d.evidence[0]), show(d));

/* ---- branch 3: hallucinated -------------------------------------------- */

d = E.diagnose(build({
  ask: { chatInput: 'Who do I contact at ACC-88421905?' },
  tool: CRM,
  answer: { output: 'Contact billing@northgate-invoices-ltd.net for that account ACC-88421905.' }
}), 'AI Agent');
check('a domain from nowhere, with context otherwise fine → hallucinated',
  d && d.branch === 'hallucinated', show(d));

/* ---- precedence: root cause beats symptom ------------------------------ */

d = E.diagnose(build({
  ask: { chatInput: 'Who do I contact about invoice INV-77310?' },
  tool: [{ invoice: 'INV-99001', contact: 'other@elsewhere.com' }],
  answer: { output: 'Contact billing@invented-domain-xyz.net about INV-77310.' }
}), 'AI Agent');
check('retrieval missed AND the answer invented — reports bad context, not hallucination',
  d && d.branch === 'bad context', show(d));

/* ---- must stay silent -------------------------------------------------- */

d = E.diagnose(build({
  ask: { chatInput: 'What tier is ACC-88421905?' },
  tool: CRM,
  answer: { account: 'ACC-88421905', tier: 'enterprise', headcount: 45 }
}), 'AI Agent');
check('a correct, grounded answer says nothing', d === null, show(d));

d = E.diagnose(build({
  ask: { chatInput: 'What tier is ACC-88421905?' },
  tool: CRM,
  answer: { account: 'ACC-88421905', tier: 'Enterprise', headcount: '45' }
}), 'AI Agent');
check('different casing and a number as a string are not contradictions', d === null, show(d));

d = E.diagnose(build({
  ask: { chatInput: 'Summarise this account for me.' },
  tool: CRM,
  answer: { output: 'Northgate Legal is an enterprise account with 45 staff.' }
}), 'AI Agent');
check('an ask with no specifics is not judged for retrieval coverage', d === null, show(d));

// Several records in the context: matching ANY of them is correct.
d = E.diagnose(build({
  ask: { chatInput: 'Which of these is mid-market?' },
  tool: [{ company: 'A', tier: 'enterprise' }, { company: 'B', tier: 'mid-market' },
         { company: 'C', tier: 'smb' }],
  answer: { company: 'B', tier: 'mid-market' }
}), 'AI Agent');
check('a value matching one of several records is not a contradiction', d === null, show(d));

// A plain LLM node with no tools has no retrieval to judge.
d = E.diagnose(build({
  ask: { chatInput: 'Write me a haiku about invoice 88421905.' },
  answer: { output: 'Numbers on paper / a quiet sum awaiting / someone to notice' }
}), 'AI Agent');
check('a node with no tools is never accused of bad retrieval', d === null, show(d));

// A plain Code node - no model wired in, so nothing here is model output and
// a mismatched value is just what the code computed.
const plain = build({ ask: { tier: 'enterprise' }, answer: { tier: 'mid-market' } });
plain.workflowData.nodes.find(n => n.name === 'AI Agent').type = 'n8n-nodes-base.code';
delete plain.workflowData.connections['Chat Model'];
delete plain.data.resultData.runData['Chat Model'];
check('a Code node with no model attached is never diagnosed',
  E.diagnose(plain, 'AI Agent') === null, show(E.diagnose(plain, 'AI Agent')));

// But the LangChain Code node, which CAN have a model attached, is judged.
const lcCode = build({ ask: { tier: 'enterprise' }, tool: CRM, answer: { tier: 'mid-market' } });
lcCode.workflowData.nodes.find(n => n.name === 'AI Agent').type = 'n8n-nodes-base.someCustomThing';
check('any node with a language model wired into it IS judged, whatever it is called',
  E.diagnose(lcCode, 'AI Agent') !== null, show(E.diagnose(lcCode, 'AI Agent')));

// A year in the ask must not be mistaken for a record id.
d = E.diagnose(build({
  ask: { chatInput: 'What were the 2026 numbers for Northgate Legal?' },
  tool: CRM, answer: { output: 'Northgate Legal had 45 staff.' }
}), 'AI Agent');
check('a year is not treated as an identifier the retrieval missed', d === null, show(d));

console.log('\n  ' + pass + '/' + total + ' passed');
if (pass !== total) process.exit(1);
