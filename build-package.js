/* Builds the Chrome Web Store package.
 *
 *   node build-package.js
 *
 * Ships ONLY what the extension runs. The test suite is deliberately left
 * out: it uses eval() and new Function() to pull functions out of source text,
 * and those are precisely the patterns store review scans for. They are
 * harmless dev tooling that the manifest never loads, but a reviewer sees the
 * pattern, not the intent - and a rejection costs days.
 *
 * The fixtures and the watcher workflow go too. Neither is code the extension
 * executes, and a 45KB JSON blob with a JavaScript engine inlined in it is not
 * something you want a reviewer puzzling over.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const src = __dirname;
const out = path.join(__dirname, 'dist');
const KEEP = ['manifest.json', 'engine.js', 'content.js', 'background.js', 'LICENSE', 'README.md'];
const KEEP_DIRS = ['icons'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const f of KEEP) {
  const from = path.join(src, f);
  if (!fs.existsSync(from)) { console.log('  MISSING ' + f); process.exit(1); }
  fs.copyFileSync(from, path.join(out, f));
}
for (const d of KEEP_DIRS) {
  fs.cpSync(path.join(src, d), path.join(out, d), { recursive: true });
}

/* ---- refuse to ship something that would be rejected ---- */

let bad = 0;

// A BOM has broken this project three times now - once silently faking a
// clean fixture, once mangling the panel, once inside manifest.json itself,
// where Chrome may simply refuse to parse the package. Check every file, not
// just the scripts.
for (const f of fs.readdirSync(out)) {
  const full = path.join(out, f);
  if (fs.statSync(full).isDirectory()) continue;
  const b = fs.readFileSync(full);
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
    console.log('  BLOCKED  ' + f + ' starts with a BOM');
    bad++;
  }
  if (!f.endsWith('.js')) continue;
  if (/\beval\s*\(|new Function\s*\(/.test(b.toString('utf8'))) {
    console.log('  BLOCKED  ' + f + ' contains eval or new Function');
    bad++;
  }
}

const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
if (m.description.length > 132) { console.log('  BLOCKED  description over 132 chars'); bad++; }
for (const size of ['16', '32', '48', '128']) {
  if (!fs.existsSync(path.join(out, 'icons', 'icon' + size + '.png'))) {
    console.log('  BLOCKED  missing icon' + size + '.png'); bad++;
  }
}
if (bad) process.exit(1);

const zip = path.join(__dirname, 'why-n8n-store-' + m.version + '.zip');
fs.rmSync(zip, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  'Compress-Archive -Path "' + out + '\\*" -DestinationPath "' + zip + '" -Force']);

const files = [];
(function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), base + e.name + '/');
    else files.push(base + e.name);
  }
})(out, '');

console.log('  store package: ' + path.basename(zip)
  + '  (' + (fs.statSync(zip).size / 1024).toFixed(1) + ' KB)');
console.log('  contains ' + files.length + ' files:');
files.forEach(f => console.log('    ' + f));
console.log('\n  version ' + m.version + ', description ' + m.description.length + '/132 chars');
