/* why? for n8n - service worker.
 *
 * Two ways in, both using the SAME injection call:
 *   1. You click the toolbar icon        (activeTab - works on any n8n URL)
 *   2. Auto-scan, if you switched it on  (host_permissions + tabs.onUpdated)
 *
 * Auto-scan used to rely on a declared content_script. That was the wrong
 * mechanism: it depends on Chrome registering scripts at install time, it
 * cannot be re-checked at runtime, and when it silently fails to register
 * there is nothing to look at. Driving injection from here means auto-scan
 * uses the exact code path the icon already proves works.
 */

importScripts('engine.js');
const E = self.WHY_ENGINE;

/* ---------- badge ----------
 *
 * Two things want the badge: a transient error from a click, and the standing
 * count of unseen findings. The count is the important one, so a transient
 * flag restores it afterwards rather than leaving the badge blank.
 */
function paintCount() {
  chrome.storage.local.get('findings', function (r) {
    const n = (r && r.findings) || 0;
    chrome.action.setBadgeText({ text: n ? String(n) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#b23b32' });
    chrome.action.setTitle({
      title: n
        ? 'why? - ' + n + ' run' + (n === 1 ? '' : 's') + ' need looking at.\nClick to see them.'
        : 'why? - scan this n8n page'
    });
  });
}

function flag(text, colour, title) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: colour });
  chrome.action.setTitle({ title: title });
  if (text) setTimeout(paintCount, 8000);
}

const BLOCKED = /^(chrome|edge|about|devtools|view-source|chrome-extension):/i;

// Exported shape kept simple so it can be unit-tested outside the browser.
function autoTarget(url) {
  var u;
  try { u = new URL(url); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  // Whole segment only. The loose form matched any path merely containing the
  // word, so a page at /my-executions-report would have triggered auto-scan.
  if (!/(^|\/)executions(\/|$)/.test(u.pathname)) return null;
  return u.origin;
}

async function runIn(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ['engine.js', 'content.js']
  });
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function () {
      if (!window.__WHY__) return 'no-engine';
      if (document.getElementById('why-n8n-panel')) return 'already-open';
      window.__WHY__.start();
      return 'ok';
    }
  });
  return (res && res[0] && res[0].result) || 'unknown';
}

/* ---------- 1. toolbar click ---------- */

chrome.action.onClicked.addListener(async function (tab) {
  if (!tab || !tab.id) return;
  const url = tab.url || '';

  if (BLOCKED.test(url) || url.indexOf('chrome.google.com/webstore') !== -1) {
    flag('!', '#d9534f', 'why? cannot run on Chrome\'s own pages.\nSwitch to your n8n tab, then click this.');
    return;
  }
  if (!url) {
    flag('!', '#d9534f', 'why? cannot read this tab. Open your n8n page and try again.');
    return;
  }

  try {
    const r = await runIn(tab.id);
    if (r === 'ok' || r === 'already-open') flag('', '#2f6feb', 'why? - scan this n8n page');
    else flag('!', '#d9534f', 'why? loaded but could not start. Reload the page and retry.');
  } catch (e) {
    flag('!', '#d9534f', 'why? could not run here: ' + ((e && e.message) || 'unknown')
      + '\nReload the n8n page and try again.');
  }
});

/* ---------- 2. auto-scan ---------- */

// Fires on full loads (status complete) AND on n8n's in-app route changes,
// which arrive as changeInfo.url without any page load.
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  const url = changeInfo.url || (changeInfo.status === 'complete' && tab ? tab.url : null);
  if (!url) return;

  const origin = autoTarget(url);
  if (!origin) return;

  chrome.storage.local.get('autoOrigins', function (r) {
    const list = (r && r.autoOrigins) || [];
    if (list.indexOf(origin) === -1) return;      // not switched on for this n8n
    runIn(tabId).catch(function (e) {
      // No host permission for this origin is the common cause - say so on the
      // badge instead of failing invisibly.
      flag('!', '#d9534f', 'why? auto-scan could not run: ' + ((e && e.message) || 'unknown')
        + '\nClick the icon to scan manually.');
    });
  });
});

/* ---------- keep permissions and the toggle in sync ---------- */

// If a user revokes site access in chrome://extensions, drop it from the
// auto list so the toggle never claims something that cannot happen.
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(function () {
    chrome.storage.local.get('autoOrigins', function (r) {
      const list = (r && r.autoOrigins) || [];
      if (!list.length) return;
      Promise.all(list.map(function (o) {
        return chrome.permissions.contains({ origins: [o + '/*'] }).catch(function () { return false; });
      })).then(function (keep) {
        const next = list.filter(function (_, i) { return keep[i]; });
        if (next.length !== list.length) chrome.storage.local.set({ autoOrigins: next });
      });
    });
  });
}

/* ---------- 3. watching, so it finds things you did not go looking for ----
 *
 * A debugging tool you have to remember to open gets used twice a month and
 * then forgotten. This polls on a timer and puts a count on the icon, so the
 * finding arrives instead of waiting to be found.
 *
 * Only origins the user explicitly switched on are polled - kept separate
 * from autoOrigins, because "open the panel when I visit an executions page"
 * and "check my n8n while I am not looking" are different permissions.
 *
 * Cost matters: the list is one request, and details are fetched ONLY for
 * executions newer than the last one seen. A quiet instance costs one request
 * per poll.
 */
const POLL_MINUTES = 10;
const MAX_DETAIL_PER_POLL = 10;

function get(keys) {
  return new Promise(function (res) { chrome.storage.local.get(keys, function (r) { res(r || {}); }); });
}
function set(patch) {
  return new Promise(function (res) { chrome.storage.local.set(patch, res); });
}

async function apiGet(origin, path, browserId) {
  const headers = { accept: 'application/json' };
  if (browserId) headers['browser-id'] = browserId;
  const r = await fetch(origin + path, { credentials: 'include', headers: headers });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function rowsOf(raw) {
  const d = raw && raw.data ? raw.data : raw;
  return Array.isArray(d) ? d : (d && d.results) || (d && d.data) || [];
}

const DONE = { success: true, error: true, crashed: true };

async function pollOrigin(origin, state) {
  const browserId = (state.browserIds || {})[origin] || '';
  const mark = Number((state.watermarks || {})[origin] || 0);
  const ignored = {};
  ((state.ignored) || []).forEach(function (k) { ignored[k] = true; });

  const list = rowsOf(await apiGet(origin, '/rest/executions?limit=20', browserId))
    .filter(function (r) { return DONE[r.status]; });
  if (!list.length) return { count: 0, mark: mark };

  const ids = list.map(function (r) { return Number(r.id) || 0; });
  const highest = Math.max.apply(null, ids.concat([mark]));

  // First run on this origin: take the high-water mark and say nothing.
  // Announcing a backlog of old failures as if they just happened would be a
  // lie, and a red badge on install is how a tool gets removed.
  if (!mark) return { count: 0, mark: highest };

  const fresh = list.filter(function (r) { return (Number(r.id) || 0) > mark; })
                    .slice(0, MAX_DETAIL_PER_POLL);

  let count = 0;
  for (const row of fresh) {
    try {
      const raw = await apiGet(origin, '/rest/executions/' + encodeURIComponent(row.id)
        + '?includeData=true', browserId);
      const exec = E.normalise(raw);
      if (!exec || !exec.data || !exec.data.resultData) continue;
      const v = E.verdict(exec);
      if (!v || v.kind === 'filtered') continue;          // working as designed
      const key = String(exec.workflowId) + '|' + String(v.node);
      if (ignored[key]) continue;
      count++;
    } catch (e) { /* one unreadable run must not abort the poll */ }
  }
  return { count: count, mark: highest };
}

async function pollAll() {
  const state = await get(['watchOrigins', 'browserIds', 'watermarks', 'ignored', 'findings']);
  const origins = state.watchOrigins || [];
  if (!origins.length) return;

  const marks = Object.assign({}, state.watermarks || {});
  let total = Number(state.findings || 0);
  let failed = 0;

  for (const origin of origins) {
    try {
      const r = await pollOrigin(origin, state);
      marks[origin] = r.mark;
      total += r.count;
    } catch (e) {
      failed++;
    }
  }

  await set({ watermarks: marks, findings: total });
  paintCount();

  // A poll that could not run must not read as an all-clear. n8n signing the
  // session out is the usual cause and it is silent otherwise.
  if (failed) {
    chrome.action.setTitle({
      title: 'why? - could not check ' + failed + ' n8n instance'
        + (failed === 1 ? '' : 's') + '.\nOpen n8n and click here to sign the check back in.'
    });
  }
}

chrome.alarms.create('why-poll', { periodInMinutes: POLL_MINUTES, delayInMinutes: 1 });
chrome.alarms.onAlarm.addListener(function (a) {
  if (a && a.name === 'why-poll') pollAll();
});

// Opening the panel is the user seeing them, so the count resets there.
chrome.action.onClicked.addListener(function () {
  chrome.storage.local.set({ findings: 0 }, paintCount);
});

chrome.runtime.onStartup.addListener(paintCount);
chrome.runtime.onInstalled.addListener(paintCount);

if (typeof module !== 'undefined') module.exports = { autoTarget: autoTarget };
