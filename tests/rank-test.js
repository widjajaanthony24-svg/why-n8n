const path = require('path');
// Replicates the exact CT1 payload from n8n Cloud, where four fields drift in
// the same run. Checks the order they come back in - the panel leads with the
// first, so the first has to be the one that explains the run.
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

const good = i => ({
  contact_name: 'Marcus Whitfield ' + i,
  contact_email: 'm.whitfield' + i + '@northgatelegal.co.uk',
  summary: 'Operations Director at Northgate Legal, a 45-person firm in Manchester. '
         + 'Strong fit for the mid-market tier based on headcount and sector. Run ' + i + '.',
  confidence: 0.88 + (i % 5) / 100,
  tier: i % 2 ? 'mid-market' : 'enterprise',
  lifecycle_stage: 'marketing_qualified'
});

// Exactly what CT1 emits with degrade:true
const degraded = {
  contact_name: 'Marcus Whitfield 15',
  contact_email: 'unknown',
  summary: "I'm sorry, I can't help with that.",
  confidence: 'high',
  tier: 'quarantined',
  lifecycle_stage: 'marketing_qualified'
};

let profile = null;
for (let i = 1; i <= 11; i++) profile = E.addToProfile(profile, good(i));

const d = E.driftAgainst(profile, degraded);
console.log('drift signals, in the order the panel shows them:\n');
d.forEach((x, i) => console.log(`  ${i + 1}. ${x.field}: ${x.kind} — was ${x.was}, now ${x.now}`));

let pass = 0, total = 0;
const check = (label, cond) => { total++; if (cond) pass++; console.log((cond ? '\n  pass  ' : '\n  FAIL  ') + label); };

check('finds all four drifted fields (not just one)', d.length === 4);
check('the refusal text is visible in the top 3', d.slice(0, 3).some(x => /I'm sorry/.test(String(x.now))));
check('lifecycle_stage, which did not change, is not flagged', !d.some(x => x.field === 'lifecycle_stage'));
check('contact_name, naturally varied, is not flagged', !d.some(x => x.field === 'contact_name'));

// A healthy run must still be silent against the same profile.
check('healthy run stays silent', E.driftAgainst(profile, good(99)).length === 0);

console.log(`\n  ${pass}/${total} passed`);
