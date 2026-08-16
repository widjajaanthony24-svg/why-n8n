const path = require('path');
// Local fault history: the panel only sees 40 runs, so "when did this start?"
// has to survive across scans and across browser sessions.
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// Pull the history block out of content.js and run it against a fake store.
const grab = (re, name) => {
  const m = src.match(re);
  if (!m) { console.log('could not extract ' + name); process.exit(1); }
  return m[0];
};
const body = [
  'var HISTORY_MAX = 4;',                 // tiny cap so pruning is observable
  'function dict(){return Object.create(null);}',
  'var faultLog = dict();',
  grab(/function recordHistory\(keys\)[\s\S]*?\n  \}/, 'recordHistory'),
  grab(/function seenSince\(key\)[\s\S]*?\n  \}/, 'seenSince'),
  'return { recordHistory, seenSince, get history(){return faultLog;}, set history(v){faultLog=v;} };'
].join('\n');

let saved = null;
const store = { set: p => { saved = p.history; } };
const H = new Function('store', body)(store);

let pass = 0, total = 0;
const check = (label, cond, detail) => {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
};

H.recordHistory(['WF1|Build CRM Record', 'WF2|Lookup']);
const first = H.history['WF1|Build CRM Record'].first;
check('records a fault the first time it is seen', !!first);
check('persists through the store', saved && !!saved['WF1|Build CRM Record']);

H.recordHistory(['WF1|Build CRM Record']);
check('a second sighting keeps the ORIGINAL first-seen date',
  H.history['WF1|Build CRM Record'].first === first,
  'first=' + H.history['WF1|Build CRM Record'].first + ' expected ' + first);
check('and increments the count', H.history['WF1|Build CRM Record'].n === 2);

check('stays silent about a fault first seen moments ago',
  H.seenSince('WF1|Build CRM Record') === null);

// Backdate it two days: now it is worth reporting.
H.history['WF1|Build CRM Record'].first = Date.now() - 2 * 86400000;
const old = H.seenSince('WF1|Build CRM Record');
check('reports a fault that predates this scan', old !== null,
  old ? 'first seen ' + new Date(old.first).toISOString() : '');

check('an unknown key returns nothing', H.seenSince('WF9|Nope') === null);
check('a null key does not throw', H.seenSince(null) === null);

// Pruning: cap is 4, push well past it, least-recently-seen must go.
H.recordHistory(['a', 'b', 'c', 'd', 'e', 'f']);
check('prunes down to the cap', Object.keys(H.history).length <= 4,
  Object.keys(H.history).length + ' entries: ' + Object.keys(H.history).join(', '));

// A key named __proto__ must not corrupt anything.
let threw = false;
try { H.recordHistory(['__proto__']); } catch (e) { threw = true; }
check('a fault key of __proto__ neither throws nor pollutes',
  !threw && ({}).first === undefined && ({}).n === undefined);

console.log('\n  ' + pass + '/' + total + ' passed');
