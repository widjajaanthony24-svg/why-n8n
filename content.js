/* why? for n8n - content script.
 *
 *   executions LIST  -> scan recent runs, list the ones that "succeeded" but
 *                       produced nothing, and flag when several workflows
 *                       started failing at the same time.
 *   single EXECUTION -> name the bad payload key, say whether it is new or
 *                       chronic, replay it.
 *
 * Navigation happens inside the panel, never by reloading the page - a full
 * page load would destroy this script and the panel with it.
 *
 * All requests are same-origin to the n8n you are signed in to. Nothing else.
 */
(function () {
  'use strict';

  var E = window.WHY_ENGINE;
  var PANEL = 'why-n8n-panel';
  var STYLE = 'why-n8n-style';
  var SCAN_LIMIT = 40;
  var HISTORY_LIMIT = 20;
  var CONCURRENCY = 6;
  var CACHE_MAX = 6;
  var CLUSTER_MS = 15 * 60 * 1000;   // failures this close together share a cause

  // Same reasoning as the engine: these are keyed by ids and node names that
  // arrive over the wire, so they get no prototype to collide with.
  function dict() { return Object.create(null); }

  var cache = dict();
  var cacheOrder = [];
  var lastTriage = null;

  var FINISHED = dict();
  FINISHED.success = true; FINISHED.error = true; FINISHED.crashed = true;

  /* ---------- network ---------- */

  function browserId() {
    try { return localStorage.getItem('n8n-browserId') || ''; } catch (e) { return ''; }
  }

  var api = window.__WHY_API__ || function (path) {
    var headers = { accept: 'application/json' };
    var id = browserId();
    if (id) headers['browser-id'] = id;
    return fetch(location.origin + path, { credentials: 'include', headers: headers }).then(function (r) {
      if (!r.ok) {
        if (r.status === 401) {
          throw new Error('HTTP 401 - n8n rejected the request. Sign in to n8n in this tab, '
            + 'reload the page, then click again.');
        }
        throw new Error('HTTP ' + r.status);
      }
      return r.json();
    });
  };

  function parseList(raw) {
    var d = raw && raw.data ? raw.data : raw;
    return Array.isArray(d) ? d : (d && d.results) || (d && d.data) || [];
  }

  function listExecutions(limit, workflowId) {
    var base = '/rest/executions?limit=' + limit;
    if (!workflowId) return api(base).then(parseList);
    return api(base + '&workflowId=' + encodeURIComponent(workflowId))
      .then(parseList, function () { return api(base).then(parseList); });
  }

  // n8n ids are opaque but always plain - alphanumeric with - and _. Anything
  // else in the path segment could bend the request onto a different endpoint.
  function safeId(v) {
    return v !== undefined && v !== null && /^[A-Za-z0-9_-]{1,64}$/.test(String(v));
  }

  function fetchExecution(id) {
    if (!safeId(id)) return Promise.reject(new Error('refusing to fetch a malformed execution id'));
    return api('/rest/executions/' + encodeURIComponent(id) + '?includeData=true').then(function (raw) {
      var exec = E.normalise(raw);
      if (!exec || !exec.data || !exec.data.resultData) throw new Error('no per-node data');
      if (!exec.id) exec.id = id;
      return exec;
    });
  }

  function getExecution(id) {
    if (cache[id]) return Promise.resolve(cache[id]);
    return fetchExecution(id).then(function (exec) {
      cache[id] = exec;
      cacheOrder.push(id);
      while (cacheOrder.length > CACHE_MAX) delete cache[cacheOrder.shift()];
      return exec;
    });
  }

  function pool(items, worker, n, onProgress) {
    var i = 0, out = [], done = 0;
    function next() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return worker(items[idx])
        .then(function (v) { out[idx] = v; }, function (e) { out[idx] = { error: e }; })
        .then(function () {
          done++;
          // Reporting progress matters more than raw speed here: a deep scan
          // over hundreds of runs is slow no matter what, and silence for
          // thirty seconds reads as a hang.
          if (onProgress) onProgress(done, items.length);
          return next();
        });
    }
    var runners = [];
    for (var k = 0; k < Math.min(n, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function () { return out; });
  }

  // A finished execution never changes, so an analysis of one is valid
  // forever. Without this, "look back further" re-fetches and re-analyses
  // every run it already looked at a moment ago - which is exactly the
  // action people complain is slow.
  var JUDGED_MAX = 600;
  var judged = dict();
  var judgedOrder = [];

  function remember(id, result) {
    if (judged[id]) return result;
    judged[id] = result;
    judgedOrder.push(id);
    while (judgedOrder.length > JUDGED_MAX) delete judged[judgedOrder.shift()];
    return result;
  }

  /* ---------- time ---------- */

  function ago(iso) {
    var t = typeof iso === 'number' ? iso : Date.parse(iso || '');
    if (!t) return '';
    var s = (Date.now() - t) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function shortAgo(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var s = (Date.now() - t) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  // Scanning every workflow is the point - it finds the broken one you were
  // not looking at. But when you already know which workflow you are debugging,
  // the rest is noise, so offer the narrowing rather than guessing at it.
  function currentWorkflowId() {
    var m = location.pathname.match(/\/workflow\/([A-Za-z0-9_-]+)/);
    return m && m[1] !== 'new' ? m[1] : null;
  }

  /* ---------- look ---------- */

  var CSS = [
    '#' + PANEL + '{position:fixed;top:16px;right:16px;z-index:2147483647;width:486px;',
    'max-height:82vh;overflow:auto;border-radius:14px;padding:16px 18px 18px;',
    'background:rgba(6,6,8,.72);-webkit-backdrop-filter:blur(18px) saturate(130%);',
    'backdrop-filter:blur(18px) saturate(130%);border:1px solid rgba(255,255,255,.18);',
    'box-shadow:0 16px 52px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,255,255,.12);',
    'color:#f4f4f4;font:12px/1.6 ui-monospace,Consolas,"Courier New",monospace;',
    '-webkit-font-smoothing:none;font-smooth:never;}',
    '#' + PANEL + '::before{content:"";position:absolute;inset:0;pointer-events:none;',
    'border-radius:14px;background-image:radial-gradient(rgba(255,255,255,.9) 1px,transparent 1.35px);',
    'background-size:5px 5px;opacity:.30;',
    '-webkit-mask-image:radial-gradient(130% 90% at 100% 0%,#000 0%,transparent 60%);',
    'mask-image:radial-gradient(130% 90% at 100% 0%,#000 0%,transparent 60%);}',
    '#' + PANEL + '::after{content:"";position:absolute;inset:0;pointer-events:none;',
    'border-radius:14px;background-image:radial-gradient(rgba(255,255,255,.9) 1.6px,transparent 2px);',
    'background-size:10px 10px;opacity:.16;',
    '-webkit-mask-image:radial-gradient(90% 60% at 100% 0%,#000 0%,transparent 55%);',
    'mask-image:radial-gradient(90% 60% at 100% 0%,#000 0%,transparent 55%);}',
    // Must not be a wildcard: `#panel *` outranks `.why-x` and would kill its
    // absolute positioning.
    '.why-body{position:relative;z-index:1}',
    '#' + PANEL + ' .why-x{position:absolute;top:12px;right:14px;width:26px;height:26px;z-index:3;',
    'display:flex;align-items:center;justify-content:center;cursor:pointer;color:#c9c9c9;',
    'font-size:16px;line-height:1;border:1px solid rgba(255,255,255,.22);border-radius:7px;',
    'background:rgba(255,255,255,.06)}',
    '#' + PANEL + ' .why-x:hover{background:#f4f4f4;color:#08080a;border-color:#f4f4f4}',
    '.why-head{display:flex;align-items:center;gap:9px;margin:0 34px 12px 0;cursor:move;',
    'user-select:none;-webkit-user-select:none}',
    '.why-sub{color:#8d8d8d;letter-spacing:.02em}',
    '.why-alert{color:#fff;font-weight:700;letter-spacing:.03em;margin:2px 0 6px}',
    // the chronic/new verdict - top of the panel, boxed, impossible to miss
    '.why-verdict{margin:8px 0 12px;padding:8px 10px;border-left:3px solid #f4f4f4;',
    'background:rgba(255,255,255,.10);color:#fff}',
    '.why-verdict.why-new{border-left-color:#8d8d8d;background:rgba(255,255,255,.05);color:#c9c9c9}',
    '.why-cluster{margin:0 0 12px;padding:8px 10px;border:1px dashed rgba(255,255,255,.4);',
    'border-radius:8px;color:#fff}',
    '.why-line{margin:2px 0;white-space:pre-wrap;word-break:break-all}',
    '.why-key{color:#fff}',
    '.why-dim{color:#9a9a9a}',
    '.why-faint{color:#6c6c6c}',
    '.why-rule{margin-top:14px;padding-top:13px;border-top:1px solid rgba(255,255,255,.16)}',
    '.why-nav{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}',
    '.why-row{display:flex;gap:10px;padding:5px 7px;margin:1px -7px;border-radius:6px;cursor:pointer}',
    '.why-row:hover{background:rgba(255,255,255,.10)}',
    '.why-row.why-seen .why-id{color:#8d8d8d}',
    '.why-id{color:#fff;width:46px}',
    '.why-when{color:#6c6c6c;width:40px;text-align:right}',
    '.why-wf{color:#9a9a9a;width:144px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.why-what{color:#e8e8e8;flex:1}',
    '.why-btn{background:transparent;color:#f4f4f4;border:1px solid rgba(255,255,255,.34);',
    'border-radius:7px;padding:7px 13px;cursor:pointer;',
    'font:12px ui-monospace,Consolas,monospace;-webkit-font-smoothing:none}',
    '.why-btn:hover{background:rgba(255,255,255,.12)}',
    '.why-btn-solid{background:#f4f4f4;color:#08080a;border-color:#f4f4f4;font-weight:700}',
    '.why-btn-solid:hover{background:#fff}',
    '.why-btn-sm{padding:5px 10px;font-size:11px}',
    '.why-toggle{margin-left:auto;color:#8d8d8d;cursor:pointer;font-size:11px;',
    'border:1px solid rgba(255,255,255,.22);border-radius:6px;padding:4px 9px}',
    '.why-toggle:hover{color:#fff;border-color:rgba(255,255,255,.5)}',
    '.why-toggle.why-on{color:#08080a;background:#f4f4f4;border-color:#f4f4f4;font-weight:700}',
    '.why-quiet{margin-top:12px;padding-top:10px;border-top:1px dashed rgba(255,255,255,.16)}',
    '.why-more{color:#8d8d8d;cursor:pointer}',
    '.why-more:hover{color:#fff}',
    '.why-mute{color:#5a5a5a;cursor:pointer;padding:0 4px;font-size:13px;order:9}',
    '.why-mute:hover{color:#fff}'
  ].join('');

  function injectStyle() {
    var s = document.getElementById(STYLE);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE;
      (document.head || document.documentElement).appendChild(s);
    }
    if (s.textContent !== CSS) s.textContent = CSS;
  }

  function pixelText(text, size, scale) {
    size = size || 11; scale = scale || 3;
    var m = document.createElement('canvas').getContext('2d');
    var font = '700 ' + size + 'px Consolas,"Courier New",monospace';
    m.font = font;
    var w = Math.max(1, Math.ceil(m.measureText(text).width) + 2);
    var h = size + 4;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.font = font;
    g.textBaseline = 'top';
    g.fillStyle = '#fff';
    g.fillText(text, 1, 1);
    try {
      var d = g.getImageData(0, 0, w, h);
      for (var i = 0; i < d.data.length; i += 4) {
        d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
        d.data[i + 3] = d.data[i + 3] > 108 ? 255 : 0;
      }
      g.putImageData(d, 0, 0);
    } catch (e) { /* decoration must never block */ }
    c.style.width = (w * scale) + 'px';
    c.style.height = (h * scale) + 'px';
    c.style.imageRendering = 'pixelated';
    c.style.display = 'block';
    return c;
  }

  /* ---------- dom ---------- */

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, cls, onclick) {
    var b = el('button', 'why-btn ' + (cls || ''), label);
    b.onclick = onclick;
    return b;
  }

  // n8n puts Save/Publish and the node toolbar in the top right, which is
  // exactly where this panel sits - and the layout differs between self-hosted
  // and Cloud, so no fixed offset clears it everywhere. Let it be dragged by
  // the header instead, and remember where it was put.
  // This whole script is re-injected on every toolbar click, so the document
  // listeners are bound once and the drag state lives on window - a later
  // injection's closure would otherwise be invisible to the listeners that
  // are actually running, and dragging would quietly stop working.
  if (!window.__WHY_DRAG__) window.__WHY_DRAG__ = { active: null };
  var DRAG = window.__WHY_DRAG__;

  function makeDraggable(panel) {
    panel.addEventListener('mousedown', function (e) {
      var t = e.target;
      if (!t || !t.closest || !t.closest('.why-head')) return;
      if (t.closest('.why-toggle, .why-btn, .why-x')) return;
      var r = panel.getBoundingClientRect();
      DRAG.active = { panel: panel, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
      e.preventDefault();
    });
  }

  if (!window.__WHY_DRAG_BOUND__) {
    window.__WHY_DRAG_BOUND__ = true;

    document.addEventListener('mousemove', function (e) {
      var d = window.__WHY_DRAG__ && window.__WHY_DRAG__.active;
      if (!d) return;
      d.panel.style.left =
        Math.max(0, Math.min(window.innerWidth - 120, d.ox + e.clientX - d.sx)) + 'px';
      d.panel.style.top =
        Math.max(0, Math.min(window.innerHeight - 40, d.oy + e.clientY - d.sy)) + 'px';
      d.panel.style.right = 'auto';
    });

    document.addEventListener('mouseup', function () {
      var d = window.__WHY_DRAG__ && window.__WHY_DRAG__.active;
      if (!d) return;
      window.__WHY_DRAG__.active = null;
      store.set({
        panelPos: {
          left: parseInt(d.panel.style.left, 10) || 0,
          top: parseInt(d.panel.style.top, 10) || 0
        }
      });
    });
  }

  function shell() {
    injectStyle();
    var panel = document.getElementById(PANEL);
    if (!panel) {
      panel = el('div');
      panel.id = PANEL;
      document.body.appendChild(panel);
      makeDraggable(panel);
      store.get(function (s) {
        var p = s && s.panelPos;
        if (!p || typeof p.left !== 'number') return;
        // Clamp on restore: the window may be smaller than when it was saved.
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 120, p.left)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 40, p.top)) + 'px';
        panel.style.right = 'auto';
      });
    }
    panel.textContent = '';
    var x = el('div', 'why-x', '×');
    x.title = 'close';
    x.onclick = function () { stopLive(); panel.remove(); };
    panel.appendChild(x);
    var body = el('div', 'why-body');
    panel.appendChild(body);
    return body;
  }

  function header(box, subtitle) {
    var h = el('div', 'why-head');
    h.appendChild(pixelText('why?', 11, 3));
    var s = el('span', 'why-sub', subtitle);
    h.appendChild(s);
    h.appendChild(autoToggle());
    box.appendChild(h);
    return s;
  }

  function line(box, label, text, cls) {
    var d = el('div', 'why-line ' + (cls || ''));
    d.textContent = (label ? label + '  ' : '      ') + text;
    box.appendChild(d);
    return d;
  }

  /* ---------- settings ---------- */

  // chrome.storage when running as an extension, localStorage otherwise. The
  // fallback is not decoration: it makes these paths testable, and keeps the
  // same code working when the engine is injected by hand.
  var LS_KEY = 'why-n8n-settings';
  var store = {
    get: function (cb) {
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(
            ['autoOrigins', 'ignored', 'panelPos', 'history', 'watchOrigins', 'browserIds',
             'typeProfiles', 'quiet'],
            function (r) { cb(r || {}); });
          return;
        }
      } catch (e) { /* fall through */ }
      var raw = {};
      try { raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* ignore */ }
      cb(raw);
    },
    set: function (patch, cb) {
      try {
        if (chrome && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set(patch, function () { cb && cb(); });
          return;
        }
      } catch (e) { /* fall through */ }
      store.get(function (cur) {
        for (var k in patch) cur[k] = patch[k];
        try { localStorage.setItem(LS_KEY, JSON.stringify(cur)); } catch (e) { /* ignore */ }
        cb && cb();
      });
    }
  };

  var ignored = dict();   // "workflowId|node" -> true, refreshed on every scan
  function ignoreKey(workflowId, node) { return String(workflowId) + '|' + String(node); }

  /* ---------- local history ----------
   *
   * The scan only ever sees the last 40 executions, so on a busy instance that
   * is a few minutes of history - and "when did this start?" is the question
   * people actually ask. Keeping a compact record of what each scan saw means
   * the answer survives past the window, and past the browser session.
   *
   * Only the fault key and timestamps are kept. No payloads, no node output.
   */
  // Named faultLog, NOT history: there is already a function history(exec)
  // below doing the chronic-versus-new check. A `var history` here is hoisted
  // over it and every single-execution view dies with "history is not a
  // function" - which is exactly what shipped in 1.0.0.
  var HISTORY_MAX = 500;
  var faultLog = dict();

  function loadSettings(cb) {
    store.get(function (s) {
      ignored = dict();
      ((s && s.ignored) || []).forEach(function (k) { ignored[k] = true; });
      loadTypeProfiles(s);
      quiet = !!(s && s.quiet);
      faultLog = dict();
      var h = (s && s.history) || {};
      Object.keys(h).forEach(function (k) {
        var e = h[k];
        if (e && typeof e.first === 'number') faultLog[k] = e;
      });
      cb();
    });
  }

  function recordHistory(keys) {
    var now = Date.now();
    keys.forEach(function (k) {
      if (!k) return;
      var e = faultLog[k];
      if (e) { e.last = now; e.n = (e.n || 0) + 1; }
      else faultLog[k] = { first: now, last: now, n: 1 };
    });

    var all = Object.keys(faultLog);
    if (all.length > HISTORY_MAX) {
      all.sort(function (a, b) { return (faultLog[a].last || 0) - (faultLog[b].last || 0); });
      all.slice(0, all.length - HISTORY_MAX).forEach(function (k) { delete faultLog[k]; });
    }

    var plain = {};
    Object.keys(faultLog).forEach(function (k) { plain[k] = faultLog[k]; });
    store.set({ history: plain });
  }

  // Only worth saying once it predates this scan - "since just now" is noise.
  function seenSince(key) {
    var e = key && faultLog[key];
    if (!e || !e.first) return null;
    return (Date.now() - e.first) > 3600000 ? e : null;
  }

  /* ---------- priors, kept per NODE TYPE ----------
   *
   * Shape drift needs a node's own history, so a workflow you built this
   * morning gets nothing until it has run eight times. That is the single
   * biggest practical hole in this tool, and the fix is that what an OpenAI
   * node normally emits does not change between your workflows.
   *
   * Learning per node TYPE instead of per node INSTANCE means the fortieth
   * workflow you write is judged from its first run, using what the other
   * thirty-nine taught it. It accumulates the longer this is installed - so
   * a fresh copy of this code starts at zero and stays there for weeks.
   *
   * It is safe by construction: a drift rule only fires on a field that was
   * present in EVERY run of the profile, and across many workflows only the
   * genuinely universal fields of a node type survive that test. The rest is
   * silently ignored rather than guessed at.
   */
  var TYPE_PROFILE_MAX = 40;
  var typeProfiles = dict();

  function loadTypeProfiles(s) {
    typeProfiles = dict();
    var t = (s && s.typeProfiles) || {};
    Object.keys(t).forEach(function (k) {
      if (t[k] && typeof t[k].runs === 'number') typeProfiles[k] = t[k];
    });
  }

  function saveTypeProfiles() {
    var keys = Object.keys(typeProfiles);
    if (keys.length > TYPE_PROFILE_MAX) {
      keys.sort(function (a, b) { return (typeProfiles[b].runs || 0) - (typeProfiles[a].runs || 0); });
      keys.slice(TYPE_PROFILE_MAX).forEach(function (k) { delete typeProfiles[k]; });
    }
    var plain = {};
    Object.keys(typeProfiles).forEach(function (k) { plain[k] = typeProfiles[k]; });
    store.set({ typeProfiles: plain });
  }

  function setIgnored(key, on, cb) {
    store.get(function (s) {
      var list = (s && s.ignored) || [];
      var i = list.indexOf(key);
      if (on && i === -1) list.push(key);
      if (!on && i !== -1) list.splice(i, 1);
      store.set({ ignored: list }, function () {
        ignored[key] = on ? true : undefined;
        if (!on) delete ignored[key];
        cb && cb();
      });
    });
  }

  // n8n rejects /rest/ calls without this header, and the service worker
  // cannot read a page's localStorage. Hand it over so background checks can
  // authenticate the same way the panel does.
  function rememberBrowserId() {
    var id = browserId();
    if (!id) return;
    store.get(function (s) {
      var map = (s && s.browserIds) || {};
      if (map[location.origin] === id) return;
      map[location.origin] = id;
      store.set({ browserIds: map });
    });
  }

  // Clicking the icon works anywhere, because activeTab grants access for that
  // one click. Auto-scan and watch are different: both have to reach this n8n
  // with NO click, which needs a real host permission. Without it the toggle
  // switches on and then silently does nothing - the worst possible outcome
  // for a feature whose whole job is to run unattended.
  //
  // chrome.permissions.request() must be called inside the user gesture, so it
  // goes FIRST. Reading storage before it would lose the gesture and the
  // prompt would never appear.
  function ensureOrigin(cb) {
    var pattern = location.origin + '/*';
    try {
      if (!chrome || !chrome.permissions || !chrome.permissions.request) { cb(true); return; }
      chrome.permissions.contains({ origins: [pattern] }, function (has) {
        if (has) { cb(true); return; }
        chrome.permissions.request({ origins: [pattern] }, function (granted) { cb(!!granted); });
      });
    } catch (e) { cb(true); }
  }

  // Both toggles share everything except which list they write to and what
  // they say, so they share an implementation too.
  function originToggle(opts) {
    var t = el('div', 'why-toggle', opts.label + ' …');
    var on = false;
    var busy = false;

    store.get(function (s) { paint(((s && s[opts.key]) || []).indexOf(location.origin) !== -1); });

    t.onclick = function () {
      if (busy) return;
      busy = true;
      if (on) { commit(false); return; }
      ensureOrigin(function (granted) {
        if (!granted) {
          busy = false;
          t.textContent = opts.label + ' needs access';
          t.title = 'Chrome declined access to ' + location.origin
            + '. Without it this cannot run unless you click the icon. Click to try again.';
          setTimeout(function () { paint(false); }, 3500);
          return;
        }
        commit(true);
      });
    };

    function commit(next) {
      store.get(function (s) {
        var cur = (s && s[opts.key]) || [];
        var i = cur.indexOf(location.origin);
        if (next && i === -1) cur.push(location.origin);
        if (!next && i !== -1) cur.splice(i, 1);
        if (next && opts.needsBrowserId) rememberBrowserId();
        var patch = {};
        patch[opts.key] = cur;
        store.set(patch, function () { busy = false; paint(next); });
      });
    }

    function paint(v) {
      on = v;
      t.textContent = opts.label + (v ? ' ON' : ' off');
      t.className = 'why-toggle' + (v ? ' why-on' : '');
      t.title = v ? opts.onTitle : opts.offTitle;
    }
    return t;
  }

  /* ---------- certainty ----------
   *
   * Not every finding is equally solid, and pretending otherwise is how a
   * tool loses trust. Some are facts about the run: a node emitted nothing, an
   * API said no, an expression pointed at a field that was not there. Others
   * are inferences from history: this output does not look like it usually
   * does, this detail appears in nothing the model was given.
   *
   * The inferences are where the value is - and where crying wolf would come
   * from. So they are labelled, and one click hides them entirely. "What if
   * it is noisy on my data next week" should be answerable in a second.
   */
  var quiet = false;

  function quietToggle(onChange) {
    var t = el('div', 'why-toggle', quiet ? 'certain only' : 'all findings');
    t.title = quiet
      ? 'Showing only findings that are facts about the run. Click to include '
        + 'the ones inferred from history.'
      : 'Showing everything, including inferences from past runs. Click to see '
        + 'only what is certain.';
    t.className = 'why-toggle' + (quiet ? ' why-on' : '');
    t.onclick = function () {
      quiet = !quiet;
      store.set({ quiet: quiet }, function () { onChange(); });
    };
    return t;
  }

  function watchToggle() {
    return originToggle({
      key: 'watchOrigins', label: 'watch', needsBrowserId: true,
      onTitle: 'Checking this n8n every 10 minutes and counting what needs looking at on the '
        + 'toolbar icon. Only while the browser is running and you are signed in. Click to stop.',
      offTitle: 'Click to check this n8n in the background and show a count on the icon, '
        + 'so you find out without opening this panel.'
    });
  }

  function autoToggle() {
    return originToggle({
      key: 'autoOrigins', label: 'auto-scan',
      onTitle: 'Scans automatically when you open an executions page. Click to turn off.',
      offTitle: 'Click to scan automatically whenever you open an executions page here.'
    });
  }

  /* ---------- job 1: triage ---------- */

  // How far back to look. Default is a compromise: reading 40 executions with
  // their data is 40 requests against someone's production n8n, so going
  // deeper is offered rather than assumed. The user decides what it costs.
  var scanDepth = SCAN_LIMIT;
  var DEPTHS = [40, 100, 250];

  function triage(force, depth) {
    if (depth) scanDepth = depth;
    if (lastTriage && !force) { renderTriage(); return; }
    var box = shell();
    var sub = header(box, 'scanning the last ' + scanDepth + ' executions…');
    var body = el('div');
    box.appendChild(body);

    listExecutions(scanDepth).then(function (rows) {
      var usable = rows.filter(function (r) { return FINISHED[r.status]; });
      if (!usable.length) { sub.textContent = 'no finished executions to check'; return; }
      var ids = usable.map(function (r) { return String(r.id); });
      var fresh = ids.filter(function (id) { return !judged[id]; }).length;
      if (fresh < ids.length) {
        sub.textContent = 'scanning — ' + (ids.length - fresh) + ' already analysed, '
          + fresh + ' to read';
      }
      return pool(ids, function (id) {
        if (judged[id]) return Promise.resolve(judged[id]);
        return fetchExecution(id).then(function (exec) {
          // Keep one sample payload per run so output shape can be compared
          // later; the rest of the execution is dropped immediately.
          var node = E.resultNode(exec);
          var items = node ? E.resultItems(exec, node) : null;
          // Claims this node could not have got from its input. Computed here
          // because it needs the whole execution, which is dropped next line.
          var invented = node ? E.provenance(exec, node) : [];
          // Whether each check could run at all, so the panel can distinguish
          // "looked and found nothing" from "had nothing to look at".
          var helpers = node ? E.helpersOf(exec, node) : [];
          // Provenance only applies to model output, so the coverage line has
          // to report that basis - not merely "had some input".
          var ctx = (node && E.isModelNode(exec, node)) ? E.contextFor(exec, node) : [];
          return remember(id, {
            id: id, v: E.verdict(exec),
            workflowId: exec.workflowId,
            workflowName: (exec.workflowData && exec.workflowData.name) || '',
            resultNode: node,
            resultType: node ? E.nodeType(exec, node) : '',
            sample: (items && items.length) ? items[0].json : null,
            invented: invented,
            provChecked: ctx.length > 0,
            aiSteps: helpers.length,
            // These three need no AI node, which is most workflows.
            apiErrors: E.errorPayloads(exec),
            lostItems: E.itemLoss(exec),
            badRefs: E.allBrokenRefs(exec)
          });
        }, function (e) { return { id: id, failed: e.message }; });
      }, CONCURRENCY, function (done, all) {
        if (done % 5 === 0 || done === all) {
          sub.textContent = 'scanning… ' + done + ' of ' + all;
        }
      }).then(function (results) {
        lastTriage = { rows: usable, results: results, skipped: rows.length - usable.length };
        loadSettings(renderTriage);
      });
    }).catch(function (e) {
      sub.textContent = 'scan failed';
      body.textContent = '';
      body.appendChild(el('div', 'why-alert', 'Could not read executions: ' + e.message));
      body.appendChild(el('div', 'why-dim',
        'This does NOT mean everything is fine - the scan did not run.'));
    });
  }

  // Several workflows failing at the same time is one cause, not N problems.
  // Keyed on each workflow's MOST RECENT failure - keying on its earliest
  // means a workflow that broke last week hides a shared outage happening now.
  //
  // Two guards against crying outage at ordinary noise. Chronic faults are
  // excluded: a workflow that fails on most of its runs is not evidence of
  // anything starting now, and on an instance where several workflows are
  // permanently broken they would otherwise trip this on every scan. And the
  // window is tight - plenty of instances fire everything off one 9am cron,
  // so "within the hour" is not a coincidence worth reporting.
  function cluster(bad, byId) {
    // A sub-workflow failing alongside its parent is one fault, not two.
    var children = {};
    bad.forEach(function (r) {
      if (r.v && r.v.sub && r.v.sub.id) children[String(r.v.sub.id)] = true;
    });

    var latest = {};
    bad.forEach(function (r) {
      if (r.routine) return;                 // already broken before now
      var m = byId[r.id] || {};
      var w = String(r.workflowId || m.workflowId || '');
      var t = Date.parse(m.startedAt || '');
      if (!w || !t || children[w]) return;
      if (!latest[w] || t > latest[w].t) {
        latest[w] = { t: t, name: m.workflowName || r.workflowName || w };
      }
    });

    var list = Object.keys(latest).map(function (k) { return latest[k]; })
      .sort(function (a, b) { return a.t - b.t; });
    if (list.length < 2) return null;
    var span = list[list.length - 1].t - list[0].t;
    if (span > CLUSTER_MS) return null;
    return {
      n: list.length, span: span, at: list[list.length - 1].t,
      names: list.map(function (x) { return x.name; })
    };
  }

  // How often each fault repeats, learned from the scan we already did.
  //
  // This is shown, NOT used to hide anything. "Happens on most runs" is what a
  // poll that finds nothing looks like - and it is equally what a workflow
  // that has been broken for two days looks like. Only the node's *type* can
  // tell those apart, so type decides what gets demoted and frequency is
  // offered to the reader, with one click to mute it for good.
  var ROUTINE_RATIO = 0.6;
  var ROUTINE_MIN = 3;

  function classify(results, byId) {
    var runsPerWf = dict(), hitsPerKey = dict();
    results.forEach(function (r) {
      if (!r || r.failed) return;
      var m = byId[r.id] || {};
      var w = String(r.workflowId || m.workflowId || '');
      if (!w) return;
      runsPerWf[w] = (runsPerWf[w] || 0) + 1;
      if (!r.v) return;
      var k = ignoreKey(w, r.v.node);
      hitsPerKey[k] = (hitsPerKey[k] || 0) + 1;
    });

    var broken = [], expected = [], muted = [];
    results.forEach(function (r) {
      if (!r || !r.v) return;
      var m = byId[r.id] || {};
      var w = String(r.workflowId || m.workflowId || '');
      var key = ignoreKey(w, r.v.node);
      r.key = key;
      r.runsSeen = runsPerWf[w] || 0;
      r.hits = hitsPerKey[key] || 0;
      r.routine = r.runsSeen >= ROUTINE_MIN && (r.hits / r.runsSeen) >= ROUTINE_RATIO;

      if (ignored[key]) muted.push(r);
      else if (r.v.kind === 'filtered') expected.push(r);   // node type only - never frequency
      else broken.push(r);
    });
    return { broken: broken, expected: expected, muted: muted };
  }

  // Runs that produced output, but not the output this node normally produces.
  // Profile is built from the OLDER runs and the NEWER ones are tested against
  // it - the question is "has this changed", so the past has to be the baseline.
  function driftScan(results, byId) {
    var groups = dict();
    results.forEach(function (r) {
      if (!r || r.failed || r.v || !r.sample || !r.resultNode) return;   // clean runs only
      var w = String(r.workflowId || '');
      if (!w) return;
      var key = w + '|' + r.resultNode;
      if (ignored[key]) return;
      (groups[key] = groups[key] || []).push(r);
    });

    var found = [];
    var judged = 0, thin = 0, byPrior = 0;          // so the panel can show its working

    Object.keys(groups).forEach(function (key) {
      var runs = groups[key];
      runs.forEach(function (r) { r.at = Date.parse((byId[r.id] || {}).startedAt || '') || 0; });
      runs.sort(function (a, b) { return a.at - b.at; });

      var type = runs[0].resultType || '';
      var split = Math.max(E.MIN_PROFILE_RUNS, Math.ceil(runs.length * 0.6));

      if (runs.length > split) {
        // Enough history of its own. Judge against itself - always sharper
        // than a prior pooled across different workflows.
        var profile = null;
        for (var i = 0; i < split; i++) profile = E.addToProfile(profile, runs[i].sample);
        for (var j = split; j < runs.length; j++) {
          judged++;
          var d = E.driftAgainst(profile, runs[j].sample);
          if (d.length) found.push({ run: runs[j], drift: d, key: key, baseline: split });
        }
      } else {
        thin += runs.length;
        // Too new to know itself - but what this KIND of node normally emits
        // has been learned from every other workflow on this instance.
        var prior = type ? typeProfiles[type] : null;
        if (prior && prior.runs >= E.MIN_PROFILE_RUNS) {
          runs.forEach(function (r) {
            byPrior++;
            var pd = E.driftAgainst(prior, r.sample, { pooled: true });
            if (pd.length) {
              found.push({ run: r, drift: pd, key: key, baseline: prior.runs, fromPrior: type });
            }
          });
        }
      }

      // Everything clean feeds the prior, whatever was judged above.
      if (type) {
        runs.forEach(function (r) { typeProfiles[type] = E.addToProfile(typeProfiles[type] || null, r.sample); });
      }
    });

    saveTypeProfiles();
    return { found: found, judged: judged, thin: thin, byPrior: byPrior,
             priorTypes: Object.keys(typeProfiles).length };
  }

  function renderTriage() {
    var box = shell();
    var t = lastTriage;
    header(box, 'scanned ' + t.results.length + ' finished runs' + (t.label ? ' of "' + t.label + '"' : ''));

    var nav = el('div', 'why-nav');
    nav.appendChild(button('Rescan', 'why-btn-sm', function () { lastTriage = null; triage(true); }));
    nav.appendChild(quietToggle(renderTriage));
    nav.appendChild(watchToggle());
    if (t.label) {
      nav.appendChild(button('All workflows', 'why-btn-sm', function () { lastTriage = null; triage(true); }));
    } else {
      var wid = currentWorkflowId();
      if (wid) {
        var wname = wid;
        t.results.forEach(function (r) {
          if (r && String(r.workflowId) === String(wid) && r.workflowName) wname = r.workflowName;
        });
        // Leading button on a workflow page: while you are building, "what
        // changed since my last run" beats "what is broken across everything".
        nav.appendChild(button('Compare each run ▸', 'why-btn-sm why-btn-solid', function () {
          lastTriage = null;
          live(wid, wname);
        }));
        nav.appendChild(button('This workflow only', 'why-btn-sm', function () {
          lastTriage = null;
          scanWorkflow(wid, wname);
        }));
      }
    }
    box.appendChild(nav);

    var byId = dict();
    t.rows.forEach(function (r) { byId[String(r.id)] = r; });

    var unreadable = t.results.filter(function (r) { return r && r.failed; });
    var g = classify(t.results, byId);
    var silent = g.broken.filter(function (r) { return r.v.kind === 'silent'; });

    function rowFor(r) {
      var meta = byId[r.id] || {};
      var row = el('div', 'why-row' + (r.seen ? ' why-seen' : ''));
      row.appendChild(el('span', 'why-id', '#' + r.id));
      row.appendChild(el('span', 'why-when', shortAgo(meta.startedAt)));
      row.appendChild(el('span', 'why-wf', meta.workflowName || r.workflowName || ''));
      var what = el('span', 'why-what', r.v.text);

      // One click to silence a wrong call, right where it is wrong. The
      // honest answer to "what if it cries wolf on my data" has to be "then
      // you mute it in one click", not "then you uninstall it".
      var mute = el('span', 'why-mute', '✕');
      mute.title = 'Never mention "' + r.v.node + '" in this workflow again';
      mute.onclick = function (ev) {
        ev.stopPropagation();
        setIgnored(r.key, true, function () { renderTriage(); });
      };
      row.appendChild(mute);
      // Frequency as context, never as a reason to hide it.
      if (r.routine) what.appendChild(el('span', 'why-faint', '   ' + r.hits + '/' + r.runsSeen + ' runs'));
      // How long this has been going on, from scans before this one. The 40-run
      // window cannot answer that; the stored history can.
      var hist = seenSince(r.key);
      if (hist) what.appendChild(el('div', 'why-faint', 'first seen ' + ago(hist.first)));
      row.appendChild(what);
      row.onclick = function () { r.seen = true; single(r.id, true); };
      return row;
    }

    if (!g.broken.length) {
      box.appendChild(el('div', 'why-key',
        'Nothing broken in the last ' + t.results.length + ' runs.'));
      // "Nothing found" is the honest answer and a terrible first impression.
      // Point at the thing that is useful when nothing is broken, because a
      // first-time user on a healthy instance otherwise sees a dead end and
      // concludes the tool does nothing.
      var wid2 = currentWorkflowId();
      var nudge = el('div', 'why-dim');
      if (wid2) {
        nudge.textContent = 'While you are building, "Compare each run" shows what your last '
          + 'change did to the output.';
      } else {
        nudge.textContent = 'Open a workflow and use "Compare each run" to see what each '
          + 'execution changed. Turn on "watch" and this checks by itself.';
      }
      box.appendChild(nudge);
    } else {
      var parts = [];
      if (silent.length) parts.push(silent.length + ' look successful but produced nothing');
      var errs = g.broken.length - silent.length;
      if (errs) parts.push(errs + ' failed outright');
      box.appendChild(el('div', 'why-alert', parts.join(', ')));

      var c = cluster(g.broken, byId);
      if (c) {
        var mins = Math.round(c.span / 60000);
        box.appendChild(el('div', 'why-cluster',
          c.n + ' different workflows failed within ' + (mins < 1 ? 'a minute' : mins + ' min')
          + ' of each other (' + c.names.join(', ') + '), most recent ' + ago(c.at)
          + ' - look for one shared cause before debugging them separately.'));
      }

      g.broken.forEach(function (r) { box.appendChild(rowFor(r)); });
      box.appendChild(el('div', 'why-faint', 'Click a row to inspect it - the panel stays open.'));
    }

    // Runs n8n called successful, that produced output, where the output is
    // not the shape this node normally emits. No judge model involved.
    var driftRes = driftScan(t.results, byId);
    // Inferred from history rather than read off the run, so it is the first
    // thing hidden when someone asks for certainties only.
    var drifted = quiet ? [] : driftRes.found;

    // Written once per scan, not per render - going "back to list" must not
    // inflate the counts or move the first-seen date.
    if (!t.recorded) {
      t.recorded = true;
      recordHistory(
        g.broken.map(function (r) { return r.key; })
          .concat(drifted.map(function (f) { return f.key; }))
      );
    }

    if (drifted.length) {
      box.appendChild(el('div', 'why-alert',
        drifted.length + ' produced output that does not match this node\'s usual shape'));
      drifted.forEach(function (f) {
        var meta = byId[f.run.id] || {};
        var row = el('div', 'why-row');
        row.appendChild(el('span', 'why-id', '#' + f.run.id));
        row.appendChild(el('span', 'why-when', shortAgo(meta.startedAt)));
        row.appendChild(el('span', 'why-wf', f.run.workflowName || ''));
        // Several fields usually drift together, and the first one found is
        // rarely the one that explains the run. Lead with the sharpest signal
        // (engine sorts them) but show the rest - the refusal text sitting in
        // a summary field is often the only line that makes the cause obvious.
        var what = el('span', 'why-what');
        var d = f.drift[0];
        what.appendChild(el('div', '',
          f.run.resultNode + ' · ' + d.field + ' ' + d.kind + ' — was ' + d.was + ', now ' + d.now));
        f.drift.slice(1, 5).forEach(function (x) {
          what.appendChild(el('div', 'why-faint',
            x.field + ' ' + x.kind + ' — was ' + x.was + ', now ' + x.now));
        });
        if (f.drift.length > 5) {
          what.appendChild(el('div', 'why-faint', '+' + (f.drift.length - 5) + ' more field(s) drifted'));
        }
        // Be explicit when the yardstick was other workflows rather than this
        // one - it is a weaker claim and should read as one.
        if (f.fromPrior) {
          what.appendChild(el('div', 'why-faint',
            'this workflow is too new to know itself — compared against ' + f.baseline
            + ' runs of ' + f.fromPrior.split('.').pop() + ' elsewhere on this instance'));
        }
        row.appendChild(what);
        row.onclick = function () { single(f.run.id, true); };
        box.appendChild(row);
      });
      box.appendChild(el('div', 'why-faint',
        'Compared against the ' + drifted[0].baseline + ' runs before them.'));
    }

    // An expression pointing at a field that is not there. Resolves to
    // nothing, node runs, field goes out blank, run is green. Probably the
    // most common silent failure in n8n and nothing else surfaces it.
    var refBad = t.results.filter(function (r) {
      return r && !r.failed && r.badRefs && r.badRefs.length && !ignored[r.key || ''];
    });
    if (refBad.length) {
      box.appendChild(el('div', 'why-alert',
        refBad.length + ' used a field that was not there'));
      refBad.forEach(function (r) {
        var meta = byId[r.id] || {};
        var row = el('div', 'why-row');
        row.appendChild(el('span', 'why-id', '#' + r.id));
        row.appendChild(el('span', 'why-when', shortAgo(meta.startedAt)));
        row.appendChild(el('span', 'why-wf', meta.workflowName || r.workflowName || ''));
        var what = el('span', 'why-what');
        r.badRefs.slice(0, 3).forEach(function (b) {
          what.appendChild(el('div', '', b.node + ' · ' + b.param + ' uses ' + b.expr));
          what.appendChild(el('div', 'why-faint',
            'there is no "' + b.missing + '" in ' + b.where
            + ' — it resolved to nothing and the run carried on'));
        });
        row.appendChild(what);
        row.onclick = function () { single(r.id, true); };
        box.appendChild(row);
      });
    }

    // A 200 response carrying an error. The HTTP node is happy - it got a
    // reply - and the API is telling you it refused. No AI node required,
    // which matters because most workflows do not have one.
    var apiBad = t.results.filter(function (r) {
      return r && !r.failed && r.apiErrors && r.apiErrors.length && !ignored[r.key || ''];
    });
    if (apiBad.length) {
      box.appendChild(el('div', 'why-alert',
        apiBad.length + ' succeeded but the response says otherwise'));
      apiBad.forEach(function (r) {
        var meta = byId[r.id] || {};
        var row = el('div', 'why-row');
        row.appendChild(el('span', 'why-id', '#' + r.id));
        row.appendChild(el('span', 'why-when', shortAgo(meta.startedAt)));
        row.appendChild(el('span', 'why-wf', meta.workflowName || r.workflowName || ''));
        var what = el('span', 'why-what');
        r.apiErrors.slice(0, 2).forEach(function (e) {
          what.appendChild(el('div', '', e.node + ' · ' + e.key + ' ' + e.why));
          what.appendChild(el('div', 'why-faint', e.value));
        });
        row.appendChild(what);
        row.onclick = function () { single(r.id, true); };
        box.appendChild(row);
      });
    }

    // Fifty rows in, forty-seven out. Nobody notices three customers vanished.
    var lost = t.results.filter(function (r) {
      return r && !r.failed && r.lostItems && r.lostItems.length && !ignored[r.key || ''];
    });
    if (lost.length) {
      box.appendChild(el('div', 'why-alert', lost.length + ' lost items partway through'));
      lost.forEach(function (r) {
        var meta = byId[r.id] || {};
        var row = el('div', 'why-row');
        row.appendChild(el('span', 'why-id', '#' + r.id));
        row.appendChild(el('span', 'why-when', shortAgo(meta.startedAt)));
        row.appendChild(el('span', 'why-wf', meta.workflowName || r.workflowName || ''));
        var what = el('span', 'why-what');
        r.lostItems.slice(0, 2).forEach(function (l) {
          what.appendChild(el('div', '', l.node + ' returned ' + l.got + ' of ' + l.had
            + ' — ' + l.lost + ' item' + (l.lost === 1 ? '' : 's') + ' never came back'));
        });
        row.appendChild(what);
        row.onclick = function () { single(r.id, true); };
        box.appendChild(row);
      });
    }

    // Output where every field is present, correctly typed and plausible - and
    // some of it was invented. Shape profiling cannot see this; comparing the
    // output against what the node was actually handed can.
    var fabricated = quiet ? [] : t.results.filter(function (r) {
      return r && !r.failed && r.invented && r.invented.length && !ignored[r.key || ''];
    });
    if (fabricated.length) {
      box.appendChild(el('div', 'why-alert',
        fabricated.length + ' produced details that are not in what the node was given'));
      fabricated.forEach(function (r) {
        var meta = byId[r.id] || {};
        var row = el('div', 'why-row');
        row.appendChild(el('span', 'why-id', '#' + r.id));
        row.appendChild(el('span', 'why-when', shortAgo(meta.startedAt)));
        row.appendChild(el('span', 'why-wf', meta.workflowName || r.workflowName || ''));
        var what = el('span', 'why-what');
        what.appendChild(el('div', '', r.resultNode + ' · invented ' + r.invented.length
          + ' detail' + (r.invented.length > 1 ? 's' : '')));
        r.invented.slice(0, 4).forEach(function (c) {
          what.appendChild(el('div', 'why-faint',
            c.field + ': ' + c.kind + ' ' + c.full + ' — appears nowhere in its input'));
        });
        row.appendChild(what);
        row.onclick = function () { single(r.id, true); };
        box.appendChild(row);
      });
      box.appendChild(el('div', 'why-faint',
        'Only ids, phone numbers, email domains and links are checked - things that '
        + 'should be copied, not composed.'));
    }

    // Everything below is deliberately quiet: it is the workflow working.
    if (g.expected.length) {
      var wrap = el('div', 'why-quiet');
      var label = function (open) {
        return (open ? '- ' : '+ ') + g.expected.length
          + ' run(s) produced nothing by design (a filter, dedupe, or nothing to start from) - '
          + (open ? 'hide' : 'show');
      };
      var link = el('div', 'why-more', label(false));
      var open = false;
      var list = el('div');
      list.style.display = 'none';
      link.onclick = function () {
        open = !open;
        list.style.display = open ? 'block' : 'none';
        link.textContent = label(open);
      };
      g.expected.forEach(function (r) { list.appendChild(rowFor(r)); });
      wrap.appendChild(link);
      wrap.appendChild(list);
      box.appendChild(wrap);
    }

    if (g.muted.length) {
      var un = el('div', 'why-more',
        g.muted.length + ' hidden by your ignore list — click to unmute all');
      un.onclick = function () {
        store.set({ ignored: [] }, function () { loadSettings(renderTriage); });
      };
      box.appendChild(un);
    }

    // Three of the four checks report by staying silent, which is
    // indistinguishable from never having run. Show the working: what each
    // check looked at, and where it had nothing to look at.
    var clean = t.results.filter(function (r) { return r && !r.failed; });
    var withCtx = clean.filter(function (r) { return r.provChecked; }).length;
    var withAi = clean.filter(function (r) { return r.aiSteps; }).length;

    var cov = el('div', 'why-quiet');
    cov.appendChild(el('div', 'why-dim', 'what was checked'));

    function covLine(name, result, basis) {
      var d = el('div', 'why-line');
      d.appendChild(el('span', 'why-key', name));
      d.appendChild(el('span', 'why-dim', '   ' + result));
      if (basis) d.appendChild(el('span', 'why-faint', '   ' + basis));
      cov.appendChild(d);
    }

    covLine('produced nothing',
      g.broken.length ? g.broken.length + ' found' : 'none',
      'all ' + clean.length + ' runs');
    covLine('field that was not there',
      refBad.length ? refBad.length + ' found' : 'none',
      'every expression in all ' + clean.length + ' runs');
    covLine('error in a 200 response',
      apiBad.length ? apiBad.length + ' found' : 'none',
      'all ' + clean.length + ' runs — no AI node needed');
    covLine('items lost mid-run',
      lost.length ? lost.length + ' found' : 'none',
      'HTTP and per-item Code nodes only');
    var driftBasis = [];
    if (driftRes.judged) driftBasis.push(driftRes.judged + ' judged on their own history');
    if (driftRes.byPrior) driftBasis.push(driftRes.byPrior + ' judged on what this node type does elsewhere');
    if (driftRes.thin && !driftRes.byPrior) driftBasis.push(driftRes.thin + ' too new to judge');
    if (quiet) {
      cov.appendChild(el('div', 'why-faint',
        'shape drift and invented details are hidden — click "certain only" to bring them back'));
    }
    covLine('shape drift',
      quiet ? 'hidden' : (drifted.length ? drifted.length + ' found' : 'none'),
      driftBasis.length ? driftBasis.join(', ')
                        : 'no node had ' + E.MIN_PROFILE_RUNS + '+ runs of history yet');
    if (driftRes.priorTypes) {
      cov.appendChild(el('div', 'why-faint',
        'learned the normal output of ' + driftRes.priorTypes
        + ' node type' + (driftRes.priorTypes === 1 ? '' : 's') + ' on this instance so far'));
    }
    covLine('invented details',
      quiet ? 'hidden' : (fabricated.length ? fabricated.length + ' found' : 'none'),
      withCtx ? withCtx + ' model runs checked against their context'
              : 'only applies to AI nodes - none of these runs used one');
    covLine('agent steps',
      withAi ? withAi + ' runs traced' : 'none',
      withAi ? '' : 'no AI nodes in these runs');

    box.appendChild(cov);

    // The window is the most common complaint, so make it the user's call
    // rather than a fixed limit they have to live with.
    var deeper = DEPTHS.filter(function (d) { return d > t.results.length; })[0];
    if (deeper && !t.label) {
      var more = el('div', 'why-more', '+ look back further — scan the last ' + deeper + ' runs');
      more.title = 'Reads ' + deeper + ' executions instead of ' + t.results.length
        + '. Slower, and more requests to your n8n.';
      more.onclick = function () { lastTriage = null; triage(true, deeper); };
      cov.appendChild(more);
    }

    if (t.skipped) box.appendChild(el('div', 'why-faint', t.skipped + ' still running or cancelled - not judged.'));
    if (unreadable.length) {
      box.appendChild(el('div', 'why-dim',
        unreadable.length + ' run(s) could not be read - not counted either way.'));
    }
  }

  /* ---------- live: the build loop ----------
   *
   * The rest of this tool answers "is something broken", which is a rare
   * question. Building a workflow means hitting Execute over and over and
   * wondering whether the last change helped - dozens of times a day, with
   * nothing to compare against but memory.
   *
   * So: leave the panel open, and every time a run finishes, say what changed
   * since the one before it.
   */
  var LIVE_MS = 4000;
  var liveLast = null;

  // The timer id lives on window, not in this closure. This whole script is
  // re-injected on every toolbar click, and a new injection's stopLive() can
  // only clear a timer it can see - so a closure-scoped id would leave the
  // previous injection's interval running forever, polling the user's n8n
  // every four seconds with no panel attached and no way to stop it.
  if (!window.__WHY_LIVE__) window.__WHY_LIVE__ = { timer: null };

  function stopLive() {
    var L = window.__WHY_LIVE__;
    if (L && L.timer) { clearInterval(L.timer); L.timer = null; }
    liveLast = null;
  }

  function live(workflowId, label) {
    stopLive();
    var box = shell();
    var sub = header(box, 'watching "' + label + '" — hit Execute in n8n');

    var nav = el('div', 'why-nav');
    nav.appendChild(button('← Back to scan', 'why-btn-sm', function () {
      stopLive(); lastTriage = null; triage(true);
    }));
    box.appendChild(nav);

    var body = el('div');
    box.appendChild(body);
    body.appendChild(el('div', 'why-dim', 'Waiting for the next run…'));

    function render(curr, prev) {
      body.textContent = '';
      var c = E.compareRuns(prev, curr);

      var head = el('div', 'why-alert',
        'run #' + curr.id + (prev ? '  vs  #' + prev.id : '  (first run seen)'));
      body.appendChild(head);

      // Broken beats changed - no point diffing output that never arrived.
      var v = E.verdict(curr);
      if (v && v.kind !== 'filtered') {
        body.appendChild(el('div', 'why-verdict', v.text));
      }

      var dx = E.resultNode(curr) ? E.diagnose(curr, E.resultNode(curr)) : null;
      if (dx) {
        var d = el('div', 'why-verdict');
        d.appendChild(el('div', 'why-alert', dx.branch));
        d.appendChild(el('div', 'why-line', dx.why));
        dx.evidence.forEach(function (e) { d.appendChild(el('div', 'why-line why-dim', '  ' + e)); });
        body.appendChild(d);
      }

      if (!prev) {
        body.appendChild(el('div', 'why-faint', 'Run it again and this will show what changed.'));
      } else if (c.identical) {
        // Genuinely useful: it means your change did nothing to the output.
        body.appendChild(el('div', 'why-key', 'Output identical to the previous run.'));
      } else {
        body.appendChild(el('div', 'why-dim',
          c.changes.length + ' change' + (c.changes.length === 1 ? '' : 's') + ' in ' + c.node));
        c.changes.slice(0, 14).forEach(function (ch) {
          var row = el('div', 'why-line');
          row.appendChild(el('span', 'why-key', ch.field));
          row.appendChild(el('span', 'why-dim', '  ' + ch.kind + '  '));
          row.appendChild(el('span', 'why-faint', ch.was + '  →  '));
          row.appendChild(el('span', 'why-what', ch.now));
          body.appendChild(row);
        });
        if (c.changes.length > 14) {
          body.appendChild(el('div', 'why-faint', '+' + (c.changes.length - 14) + ' more'));
        }
      }

      var foot = el('div', 'why-rule');
      foot.appendChild(button('Inspect this run', 'why-btn-sm', function () {
        stopLive(); single(curr.id, false);
      }));
      body.appendChild(foot);
    }

    function tick() {
      if (document.hidden) return;                 // no point polling a hidden tab
      // n8n is a single-page app, so moving to another workflow does not
      // reload anything. Without this the panel keeps reporting runs of the
      // workflow you just left, which reads as flatly wrong.
      var here = currentWorkflowId();
      if (here && String(here) !== String(workflowId)) {
        stopLive();
        sub.textContent = 'you moved to another workflow';
        body.textContent = '';
        body.appendChild(button('Compare runs here instead', 'why-btn-sm', function () {
          live(here, here);
        }));
        return;
      }
      listExecutions(3, workflowId).then(function (rows) {
        var done = rows.filter(function (r) { return FINISHED[r.status]; });
        if (!done.length) return;
        var newest = String(done[0].id);
        if (newest === liveLast) return;
        liveLast = newest;
        sub.textContent = 'watching "' + label + '" — last run ' + shortAgo(done[0].startedAt) + ' ago';

        var older = done[1] ? String(done[1].id) : null;
        var jobs = [fetchExecution(newest)];
        if (older) jobs.push(fetchExecution(older).catch(function () { return null; }));
        Promise.all(jobs).then(function (got) {
          render(got[0], got[1] || null);
        }, function (e) {
          body.textContent = '';
          body.appendChild(el('div', 'why-alert', 'Could not read run #' + newest + ': ' + e.message));
        });
      }, function (e) {
        sub.textContent = 'lost contact with n8n — ' + e.message;
      });
    }

    tick();
    window.__WHY_LIVE__.timer = setInterval(tick, LIVE_MS);
  }

  function scanWorkflow(workflowId, label) {
    var box = shell();
    var sub = header(box, 'scanning "' + label + '"…');
    listExecutions(SCAN_LIMIT, workflowId).then(function (rows) {
      var usable = rows.filter(function (r) {
        return FINISHED[r.status] && String(r.workflowId) === String(workflowId);
      });
      if (!usable.length) { sub.textContent = 'no finished runs of "' + label + '"'; return; }
      return pool(usable.map(function (r) { return String(r.id); }), function (id) {
        return fetchExecution(id).then(function (exec) {
          // Same sample capture as the instance-wide scan. Without it the
          // scoped view would quietly lose drift detection entirely.
          var node = E.resultNode(exec);
          var items = node ? E.resultItems(exec, node) : null;
          // Claims this node could not have got from its input. Computed here
          // because it needs the whole execution, which is dropped next line.
          var invented = node ? E.provenance(exec, node) : [];
          // Whether each check could run at all, so the panel can distinguish
          // "looked and found nothing" from "had nothing to look at".
          var helpers = node ? E.helpersOf(exec, node) : [];
          // Provenance only applies to model output, so the coverage line has
          // to report that basis - not merely "had some input".
          var ctx = (node && E.isModelNode(exec, node)) ? E.contextFor(exec, node) : [];
          return {
            id: id, v: E.verdict(exec), workflowId: exec.workflowId,
            workflowName: (exec.workflowData && exec.workflowData.name) || label,
            resultNode: node,
            resultType: node ? E.nodeType(exec, node) : '',
            sample: (items && items.length) ? items[0].json : null,
            invented: invented,
            provChecked: ctx.length > 0,
            aiSteps: helpers.length,
            // These three need no AI node, which is most workflows.
            apiErrors: E.errorPayloads(exec),
            lostItems: E.itemLoss(exec),
            badRefs: E.allBrokenRefs(exec)
          };
        }, function (e) { return { id: id, failed: e.message }; });
      }, CONCURRENCY).then(function (results) {
        lastTriage = { rows: usable, results: results, skipped: rows.length - usable.length, label: label };
        loadSettings(renderTriage);
      });
    }).catch(function (e) {
      sub.textContent = 'scan failed';
      box.appendChild(el('div', 'why-alert', 'Could not read that workflow: ' + e.message));
    });
  }

  /* ---------- job 2: one execution ---------- */

  function single(id, fromList) {
    var box = shell();
    var sub = header(box, 'reading execution ' + id + '…');
    getExecution(id).then(function (exec) {
      draw(box, sub, exec, fromList);
      history(exec);
    }).catch(function (e) {
      sub.textContent = 'could not read execution ' + id;
      box.appendChild(el('div', 'why-alert', e.message));
    });
  }

  // The backwards trace: what the node was given, what its tools returned,
  // and anything in the answer that came from neither. This is the step people
  // describe doing by hand through nested JSON.
  function agentSection(box, exec) {
    var node = E.resultNode(exec);
    if (!node) return;
    var steps = E.agentTrace(exec, node);
    var invented = E.provenance(exec, node);
    var dx = E.diagnose(exec, node);
    if (!steps.length && !invented.length && !dx) return;

    var wrap = el('div', 'why-rule');

    // Which KIND of wrong leads, because it decides where the afternoon goes:
    // a retrieval bug, a prompt bug and a model bug are different work.
    if (dx) {
      var box2 = el('div', 'why-verdict');
      box2.appendChild(el('div', 'why-alert', dx.branch));
      box2.appendChild(el('div', 'why-line', dx.why));
      dx.evidence.forEach(function (e) {
        box2.appendChild(el('div', 'why-line why-dim', '  ' + e));
      });
      if (dx.branch === 'wrong decision') {
        box2.appendChild(el('div', 'why-faint',
          'Only contradictions of its own source can be seen from here - a '
          + 'plausible answer that is simply wrong cannot.'));
      }
      wrap.appendChild(box2);
    }

    if (invented.length && (!dx || dx.branch !== 'hallucinated')) {
      wrap.appendChild(el('div', 'why-alert',
        invented.length + ' detail' + (invented.length > 1 ? 's' : '')
        + ' in the answer came from nothing it was given'));
      invented.forEach(function (c) {
        line(wrap, '', c.field + ':  ' + c.full + '   (' + c.kind + ')', 'why-key');
      });
      wrap.appendChild(el('div', 'why-faint',
        'Checked against the main input, every sub-node that ran, and the '
        + 'intermediate steps.'));
    }

    if (steps.length) {
      wrap.appendChild(el('div', 'why-alert', 'What ' + node + ' had to work with'));
      steps.forEach(function (s) {
        if (s.from === 'step') {
          line(wrap, '', 'called ' + s.tool + '(' + s.input + ')', 'why-key');
        } else {
          line(wrap, '', s.tool + '   [' + s.kind + ', ' + s.calls + ' call'
            + (s.calls > 1 ? 's' : '') + ']', 'why-key');
        }
        if (s.output) line(wrap, '', '→ ' + s.output, 'why-dim');
      });
    }

    box.appendChild(wrap);
  }

  function draw(box, sub, exec, fromList) {
    sub.textContent = ((exec.workflowData && exec.workflowData.name) || 'workflow')
      + '  ·  execution ' + exec.id;

    var nav = el('div', 'why-nav');
    if (fromList && lastTriage) nav.appendChild(button('← Back to list', 'why-btn-sm', function () { renderTriage(); }));
    else nav.appendChild(button('Scan recent runs', 'why-btn-sm', function () { triage(); }));
    // Ids come off the wire, so they are treated as untrusted even though they
    // arrive from n8n: anything but a plain id could steer this navigation.
    if (safeId(exec.workflowId) && safeId(exec.id)) {
      nav.appendChild(button('Open in n8n ↗', 'why-btn-sm', function () {
        location.href = location.origin + '/workflow/' + exec.workflowId + '/executions/' + exec.id;
      }));
    }
    box.appendChild(nav);

    if (!FINISHED[exec.status]) {
      box.appendChild(el('div', 'why-alert', 'This execution is still ' + (exec.status || 'in progress') + '.'));
      box.appendChild(el('div', 'why-dim', 'Nothing to judge yet - nodes that have not run are not failures.'));
      return;
    }

    var r = E.analyze(exec);
    if (r.clean) {
      box.appendChild(el('div', 'why-key', 'Nothing looks wrong - every node produced output.'));
      // Still worth showing: a run can be structurally perfect and still have
      // an invented fact in it.
      agentSection(box, exec);
      return;
    }

    if (r.sub) {
      box.appendChild(el('div', 'why-alert',
        r.target.name + ' returned nothing' + (r.skipped ? ' → ' + r.skipped + ' never ran' : '')));
      box.appendChild(el('div', 'why-dim',
        'That node runs a sub-workflow' + (r.sub.name ? ' ("' + r.sub.name + '")' : '')
        + ', so the cause is inside it, not in this run\'s payload.'));
      var subfoot = el('div', 'why-rule');
      if (r.sub.id) {
        subfoot.appendChild(button('Scan that sub-workflow', 'why-btn-solid', function () {
          scanWorkflow(r.sub.id, r.sub.name || r.sub.id);
        }));
      }
      box.appendChild(subfoot);
      return;
    }

    var head = r.target.why === 'failed'
      ? r.target.name + ' failed' + (r.err.httpCode ? '  (' + r.err.httpCode + ')' : '')
      : r.target.name + ' ' + r.target.why + (r.skipped ? ' → ' + r.skipped + ' never ran' : '');
    box.appendChild(el('div', 'why-alert', head));

    // A reducer emptying is the workflow working. Say so plainly instead of
    // dressing it up as a fault.
    if (r.target.kind === 'filtered') {
      box.appendChild(el('div', 'why-verdict why-new',
        'This is the workflow working, not a fault - nothing got past this node, '
        + 'so nothing downstream had anything to do.'));
    } else {
      // Chronic-or-new goes HERE, above the detail - it decides what you do next.
      var verdict = el('div', 'why-verdict why-new', 'checking whether this is new…');
      verdict.id = 'why-history';
      box.appendChild(verdict);
    }

    if (r.err && r.err.message) box.appendChild(el('div', 'why-dim', r.err.message));

    r.exprs.forEach(function (e, i) {
      line(box, i === 0 ? 'EXPR ' : '', e[0] + ' = ' + E.show(e[1], 120), 'why-dim');
    });

    if (r.keys.length) {
      r.keys.slice(0, 5).forEach(function (k, i) {
        line(box, i === 0 ? 'KEY  ' : '', k[0][0] + ' = ' + E.show(k[0][1]) + '   <- ' + k[1], 'why-key');
      });
    } else if (!r.exprs.length) {
      line(box, 'KEY  ', 'nothing empty in the payload - check the node config', 'why-dim');
    }
    r.context.forEach(function (c, i) {
      line(box, i === 0 ? 'ALSO ' : '', c[0] + ' = ' + E.show(c[1]), 'why-dim');
    });
    if (r.from) {
      box.appendChild(el('div', 'why-faint',
        '      from "' + r.from + '"' + (r.total > 1 ? '  (' + r.total + ' items)' : '')));
    }

    agentSection(box, exec);

    var foot = el('div', 'why-rule');

    // Mute this exact fault for this workflow. Without an off switch, one
    // expected-empty node poisons every future scan.
    if (exec.workflowId && r.target && r.target.name) {
      var key = ignoreKey(exec.workflowId, r.target.name);
      var mute = el('div', 'why-more');
      var paintMute = function () {
        mute.textContent = ignored[key]
          ? '✓ ignoring "' + r.target.name + '" in this workflow - click to unignore'
          : 'Ignore "' + r.target.name + '" in this workflow (expected behaviour)';
      };
      mute.onclick = function () {
        setIgnored(key, !ignored[key], function () { paintMute(); });
      };
      loadSettings(paintMute);
      mute.style.marginBottom = '10px';
      foot.appendChild(mute);
    }

    if (r.items && r.items.length) {
      var copy = button('Copy payload', '', function () {
        navigator.clipboard.writeText(JSON.stringify(r.items.map(function (i) { return i.json; }), null, 2))
          .then(function () {
            copy.textContent = 'Copied ' + r.total + ' item' + (r.total === 1 ? '' : 's');
            setTimeout(function () { copy.textContent = 'Copy payload'; }, 1800);
          }, function () { copy.textContent = 'Copy failed'; });
      });
      copy.style.marginRight = '8px';
      foot.appendChild(copy);
    }

    var rp = E.replayTarget(exec, location.origin);
    if (rp) {
      var out = el('div', 'why-dim');
      var btn = button('Replay this payload', 'why-btn-solid', function () {
        btn.disabled = true;
        out.textContent = 'replaying ' + rp.method + ' ' + rp.url + ' …';
        fetch(rp.url, { method: rp.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(rp.body) })
          .then(function (res) { out.textContent = '→ HTTP ' + res.status + (res.ok ? '  (new execution started)' : ''); btn.disabled = false; },
                function (e) { out.textContent = '→ failed: ' + e.message; btn.disabled = false; });
      });
      foot.appendChild(btn);
      foot.appendChild(el('div', 'why-faint', E.show(rp.body, 160)));
      foot.appendChild(out);
    } else {
      foot.appendChild(el('div', 'why-dim',
        'Not a webhook trigger - copy the payload, then use Retry in the n8n UI.'));
    }
    box.appendChild(foot);
  }

  // New or chronic, and since when.
  function history(exec) {
    var slot = function () { return document.getElementById('why-history'); };
    if (!FINISHED[exec.status]) return;
    var r = E.analyze(exec);
    if (r.clean || r.target.why === 'failed') { var s0 = slot(); if (s0) s0.remove(); return; }
    var wid = exec.workflowId;
    if (!wid) { var s1 = slot(); if (s1) s1.remove(); return; }

    listExecutions(HISTORY_LIMIT, wid).then(function (rows) {
      var mine = rows.filter(function (x) {
        return String(x.workflowId) === String(wid) && FINISHED[x.status] && String(x.id) !== String(exec.id);
      }).slice(0, HISTORY_LIMIT);
      if (mine.length < 2) { var s = slot(); if (s) s.remove(); return; }

      return pool(mine.map(function (x) { return String(x.id); }), function (id) {
        return fetchExecution(id).then(function (e) { return E.verdict(e); }, function () { return undefined; });
      }, CONCURRENCY).then(function (vs) {
        var affected = [];
        vs.forEach(function (v, i) {
          if (v && v.kind === 'silent' && v.node === r.target.name) affected.push(mine[i]);
        });
        var s = slot();
        if (!s) return;                        // user moved on inside the panel
        var total = mine.length + 1;
        var n = affected.length + 1;           // include the one being viewed

        if (!affected.length) {
          s.className = 'why-verdict why-new';
          s.textContent = 'NEW - first time in the last ' + total + ' runs of this workflow.';
          return;
        }
        var oldest = affected.reduce(function (a, b) {
          return Date.parse(a.startedAt || '') <= Date.parse(b.startedAt || '') ? a : b;
        });
        s.className = 'why-verdict';
        s.textContent = 'CHRONIC - same problem in ' + n + ' of the last ' + total
          + ' runs, first seen ' + ago(oldest.startedAt) + ' (#' + oldest.id + '). '
          + 'Something changed then - stop debugging this one record.';
      });
    }).catch(function () { var s = slot(); if (s) s.remove(); });
  }

  /* ---------- entry ---------- */

  function looksLikeN8n() {
    try { if (localStorage.getItem('n8n-browserId')) return true; } catch (e) { /* blocked */ }
    if (/n8n/i.test(document.title)) return true;
    if (document.querySelector('#n8n-app, [class*="n8n"], [data-test-id^="n8n"]')) return true;
    return false;
  }

  function notN8n() {
    var box = shell();
    header(box, 'this is not an n8n page');
    box.appendChild(el('div', 'why-alert', 'Open n8n first.'));
    box.appendChild(el('div', 'why-dim', 'Go to your n8n, open Executions, then click why? again.'));
    var foot = el('div', 'why-rule');
    foot.appendChild(button('Scan anyway', '', function () { triage(true); }));
    foot.appendChild(el('div', 'why-faint', 'Use this if you are on n8n and the check got it wrong.'));
    box.appendChild(foot);
  }

  function start() {
    rememberBrowserId();
    var m = location.pathname.match(/\/executions\/(\d+)/);
    if (m) { single(m[1], false); return; }
    if (!looksLikeN8n()) { notN8n(); return; }
    triage();
  }

  window.__WHY__ = { start: start, triage: triage, single: single, engine: E };
})();
