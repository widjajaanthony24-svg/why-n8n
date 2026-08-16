const path = require('path');
// Does shape-drift detection catch "confidently wrong" output without a judge
// model - and, just as importantly, stay quiet on output that is merely varied?
require(path.join(__dirname, '..', 'engine.js'));
const E = globalThis.WHY_ENGINE;

// 12 healthy runs of a lead-enrichment node
function good(i) {
  return {
    contact_name: 'Marcus Whitfield ' + i,
    contact_email: 'm.whitfield' + i + '@northgatelegal.co.uk',
    summary: 'Operations Director at Northgate Legal, a 45-person firm in Manchester. '
           + 'Strong fit for the mid-market tier based on headcount and sector. Run ' + i + '.',
    confidence: 0.88 + (i % 5) / 100,
    tier: i % 2 ? 'mid-market' : 'enterprise',
    processed_at: '2026-08-1' + (i % 5) + 'T09:00:00Z'
  };
}

let profile = null;
for (let i = 0; i < 12; i++) profile = E.addToProfile(profile, good(i));

const cases = [
  ['healthy run (MUST be silent)', good(99), 0],
  ['LLM refusal instead of a summary', Object.assign(good(1), { summary: "I'm sorry, I can't help with that." }), 1],
  ['score silently became null', Object.assign(good(2), { confidence: null }), 1],
  ['score came back as a string', Object.assign(good(3), { confidence: 'high' }), 1],
  ['confidence wildly out of range', Object.assign(good(4), { confidence: 47 }), 1],
  ['email is no longer an email', Object.assign(good(5), { contact_email: 'unknown' }), 1],
  ['tier has a value never seen before', Object.assign(good(6), { tier: 'quarantined' }), 1],
  ['name field is varied by nature (MUST be silent)', Object.assign(good(7), { contact_name: 'Totally New Person' }), 0]
];

let pass = 0;
console.log('profile built from ' + profile.runs + ' healthy runs\n');
for (const [label, item, expect] of cases) {
  const d = E.driftAgainst(profile, item);
  const ok = expect === 0 ? d.length === 0 : d.length >= 1;
  pass += ok ? 1 : 0;
  const detail = d.map(x => `${x.field}: ${x.kind} (was ${x.was} / now ${x.now})`).join('; ') || 'no drift';
  console.log(`${ok ? '  pass  ' : '  FAIL  '}${label}\n          ${detail}`);
}

// Guard: with too little history it must refuse to judge at all.
let thin = null;
for (let i = 0; i < 4; i++) thin = E.addToProfile(thin, good(i));
const thinDrift = E.driftAgainst(thin, Object.assign(good(1), { summary: 'nope' }));
const thinOk = thinDrift.length === 0;
pass += thinOk ? 1 : 0;
console.log(`${thinOk ? '  pass  ' : '  FAIL  '}refuses to judge on only 4 runs of history (needs ${E.MIN_PROFILE_RUNS})`);

console.log(`\n  ${pass}/${cases.length + 1} passed`);
