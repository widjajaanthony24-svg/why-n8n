// Scope collisions in the content script.
//
// This exists because of a real bug that shipped in three consecutive
// releases: a `var history = ...` was declared in the same scope as an
// existing `function history(exec)`. The function is hoisted, the var
// assignment overwrites it, and every single-execution view died with
// "history is not a function".
//
// The unit tests could not have caught it. They extract functions into a
// fresh scope, where the collision does not exist - so the very technique
// that makes the panel testable also hides this class of bug. Hence a check
// that reads the file as text.
const fs = require('fs');
const path = require('path');

const files = ['content.js', 'engine.js', 'background.js'];
let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

for (const f of files) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  const fns = new Map();
  let m;
  const fnRe = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = fnRe.exec(src)) !== null) fns.set(m[1], lineOf(src, m.index));

  const vars = new Map();
  const varRe = /^\s*var\s+([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = varRe.exec(src)) !== null) {
    if (!vars.has(m[1])) vars.set(m[1], lineOf(src, m.index));
  }

  const clashes = [];
  for (const [name, vLine] of vars) {
    if (fns.has(name)) clashes.push(name + ' (var line ' + vLine + ', function line ' + fns.get(name) + ')');
  }

  check(f + ': no name declared as both a var and a function',
    clashes.length === 0, clashes.join('\n          '));
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

// The panel also relies on a handful of names existing at call time. A typo or
// a rename that misses a call site is invisible until someone clicks.
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const mustExist = ['loadSettings', 'recordHistory', 'seenSince', 'renderTriage',
                   'driftScan', 'agentSection', 'single', 'triage', 'scanWorkflow'];
const missing = mustExist.filter(n =>
  !new RegExp('function\\s+' + n + '\\s*\\(').test(content));
check('every function the panel calls is actually defined',
  missing.length === 0, missing.join(', '));

// Every name called as a function must not also be assigned a non-function.
const calledNames = new Set();
let c;
const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
while ((c = callRe.exec(content)) !== null) calledNames.add(c[1]);
const assignedObjects = [];
const objRe = /^\s*var\s+([A-Za-z_$][\w$]*)\s*=\s*(dict\(\)|\{|\[)/gm;
while ((c = objRe.exec(content)) !== null) {
  if (calledNames.has(c[1])) assignedObjects.push(c[1] + ' at line ' + lineOf(content, c.index));
}
check('nothing assigned an object or array is also called as a function',
  assignedObjects.length === 0, assignedObjects.join(', '));

console.log('\n  ' + pass + '/' + total + ' passed');
