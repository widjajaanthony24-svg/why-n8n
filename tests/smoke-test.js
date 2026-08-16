// Loads the real content script in a stub browser and opens the panel.
//
// This exists because of the class of bug that unit tests here structurally
// cannot catch. Every other suite pulls functions out of the source into a
// fresh scope; that is what makes them testable, and it is also why a
// `var history` shadowing `function history()` shipped in three consecutive
// releases. Nothing executed the file as a whole until a user clicked.
//
// So: build enough of a browser to run it for real, drive each entry point,
// and fail on any exception. Not a UI test - a "does it start" test.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, total = 0;
function check(label, cond, detail) {
  total++; if (cond) pass++;
  console.log((cond ? '  pass  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
}

/* ---- the smallest browser that will do -------------------------------- */

function makeEl(tag) {
  const e = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {},
    className: '', id: '', title: '', textContent: '', disabled: false,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener() {}, removeEventListener() {},
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 300 }; },
    setAttribute() {}, getAttribute() { return null; }
  };
  if (e.tagName === 'CANVAS') {
    e.width = 0; e.height = 0;
    e.getContext = () => ({
      font: '', textBaseline: '', fillStyle: '', imageSmoothingEnabled: true,
      measureText: t => ({ width: String(t).length * 6 }),
      fillText() {},
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
      putImageData() {}
    });
  }
  return e;
}

function browser(opts) {
  const byId = {};
  const doc = {
    hidden: false,
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    createElement: makeEl,
    getElementById: id => byId[id] || null,
    addEventListener() {}
  };
  // shell() looks the panel up by id after appending it
  const realAppend = doc.body.appendChild.bind(doc.body);
  doc.body.appendChild = function (c) { if (c.id) byId[c.id] = c; return realAppend(c); };

  const storage = {};
  const win = {
    document: doc,
    location: { origin: 'https://x.app.n8n.cloud', pathname: opts.pathname, href: '' },
    localStorage: {
      getItem: k => (k === 'n8n-browserId' ? 'browser-id-stub' : null),
      setItem() {}
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    innerWidth: 1400, innerHeight: 900,
    setInterval: () => 1, clearInterval() {}, setTimeout: (f) => { return 1; },
    __WHY_API__: opts.api
  };
  win.window = win;

  const chrome = {
    storage: { local: {
      get: (keys, cb) => cb(storage),
      set: (patch, cb) => { Object.assign(storage, patch); cb && cb(); }
    } },
    permissions: {
      contains: (o, cb) => cb(true),
      request: (o, cb) => cb(true)
    }
  };

  return vm.createContext(Object.assign(win, {
    chrome, console, JSON, Math, Date, Object, Array, String, Number, Boolean,
    RegExp, Error, Promise, isFinite, isNaN, parseInt, parseFloat, undefined: void 0,
    Uint8ClampedArray, encodeURIComponent, decodeURIComponent, setTimeout: win.setTimeout,
    setInterval: win.setInterval, clearInterval: win.clearInterval
  }));
}

/* ---- fixtures the fake n8n will serve ---------------------------------- */

function execFor(id, opts) {
  opts = opts || {};
  return {
    id: String(id), workflowId: 'WF1', status: 'success',
    workflowData: { name: 'Lead Enrichment',
      nodes: [{ name: 'Trigger', type: 'n8n-nodes-base.webhook' },
              { name: 'Build', type: 'n8n-nodes-base.code' }],
      connections: { Trigger: { main: [[{ node: 'Build', type: 'main', index: 0 }]] } } },
    data: { resultData: { runData: {
      Trigger: [{ executionIndex: 0, data: { main: [[{ json: { company: 'Northgate' } }]] } }],
      Build: [{ executionIndex: 1, source: [{ previousNode: 'Trigger' }],
        data: { main: [opts.empty ? [] : [{ json: { tier: 'enterprise', n: id } }]] } }]
    } } }
  };
}

function api(spec) {
  return function (p) {
    if (/\/rest\/executions\?/.test(p)) {
      return Promise.resolve({ data: spec.list.map(id => ({
        id: String(id), status: 'success', workflowId: 'WF1',
        workflowName: 'Lead Enrichment', startedAt: new Date().toISOString()
      })) });
    }
    const m = p.match(/\/rest\/executions\/([^?]+)/);
    if (m) return Promise.resolve(execFor(m[1], { empty: spec.empty && spec.empty.includes(m[1]) }));
    return Promise.reject(new Error('unexpected ' + p));
  };
}

function load(ctx) {
  for (const f of ['engine.js', 'content.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return ctx.window.__WHY__;
}

function settle() { return new Promise(r => setImmediate(() => setImmediate(r))); }

// "It did not throw" is too weak. The bug this file was written for was caught
// by an internal .catch() and rendered INTO the panel as "history is not a
// function" - so nothing reached the top level and everything looked fine.
// The real question is whether the panel is showing a result or an apology.
const BROKEN_TEXT = /is not a function|is not defined|undefined is not|\[object Object\]|NaN|could not read execution/i;

function panelText(ctx) {
  const p = ctx.window.document.getElementById('why-n8n-panel');
  if (!p) return '';
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.textContent) out.push(n.textContent);
    (n.children || []).forEach(walk);
  })(p);
  return out.join(' | ');
}

function assertRendered(ctx, label) {
  const text = panelText(ctx);
  const hit = text.match(BROKEN_TEXT);
  check(label, !hit, hit ? 'panel is showing: …' + text.slice(Math.max(0, hit.index - 60), hit.index + 80) + '…' : '');
}

/* ---- drive every entry point ------------------------------------------ */

(async function () {
  // 1. executions list, some broken
  let ctx = browser({ pathname: '/home/executions', api: api({ list: [5, 4, 3, 2, 1], empty: ['3', '2'] }) });
  let W, err = null;
  try { W = load(ctx); W.start(); await settle(); await settle(); }
  catch (e) { err = e; }
  check('the script loads and start() runs on an executions list', !err, err && err.stack);
  check('a panel was actually put on the page',
    !!ctx.window.document.getElementById('why-n8n-panel'));
  assertRendered(ctx, 'the executions list shows findings, not an error');

  // 2. single execution page - the path that was broken for three releases
  ctx = browser({ pathname: '/workflow/WF1/executions/3', api: api({ list: [5, 4, 3], empty: ['3'] }) });
  err = null;
  try { W = load(ctx); W.start(); await settle(); await settle(); await settle(); }
  catch (e) { err = e; }
  check('a single execution renders without throwing', !err, err && err.stack);
  assertRendered(ctx, 'the single-execution view shows a diagnosis, not an error');

  // 3. workflow editor page
  ctx = browser({ pathname: '/workflow/WF1', api: api({ list: [5, 4, 3] }) });
  err = null;
  try { W = load(ctx); W.start(); await settle(); await settle(); }
  catch (e) { err = e; }
  check('the workflow editor page renders without throwing', !err, err && err.stack);
  assertRendered(ctx, 'the workflow editor page shows a result, not an error');

  // 4. a healthy instance - the most likely first-run experience
  ctx = browser({ pathname: '/home/executions', api: api({ list: [9, 8, 7] }) });
  err = null;
  try { W = load(ctx); W.triage(true); await settle(); await settle(); }
  catch (e) { err = e; }
  check('a healthy instance renders the empty state without throwing', !err, err && err.stack);
  assertRendered(ctx, 'the empty state reads as an all-clear, not a failure');

  // 5. n8n refusing the request
  ctx = browser({ pathname: '/home/executions', api: () => Promise.reject(new Error('HTTP 401')) });
  err = null;
  try { W = load(ctx); W.start(); await settle(); await settle(); }
  catch (e) { err = e; }
  check('a 401 from n8n is handled, not thrown', !err, err && err.stack);

  // 6. not n8n at all
  ctx = browser({ pathname: '/some/other/site', api: api({ list: [] }) });
  err = null;
  try { W = load(ctx); W.start(); await settle(); }
  catch (e) { err = e; }
  check('a non-n8n page renders its explanation without throwing', !err, err && err.stack);

  // 7. re-injection, which happens on every toolbar click
  ctx = browser({ pathname: '/home/executions', api: api({ list: [5, 4, 3], empty: ['3'] }) });
  err = null;
  try {
    W = load(ctx); W.start(); await settle();
    W = load(ctx); W.start(); await settle(); await settle();
  } catch (e) { err = e; }
  check('clicking the icon twice re-injects cleanly', !err, err && err.stack);

  console.log('\n  ' + pass + '/' + total + ' passed');
  if (pass !== total) process.exit(1);
})();
