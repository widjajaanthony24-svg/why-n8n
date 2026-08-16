/* why? for n8n - analysis engine (no DOM, no network).
 * Shared by the content script and the offline CLI. */
(function (root) {
  'use strict';

  function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  // Every map below is keyed by something an attacker controls: payload field
  // names, payload values, node types. A plain {} inherits from
  // Object.prototype, so a field called "__proto__" reads back the prototype
  // itself - truthy, so the "not seen yet" branch is skipped - and the next
  // write lands on Object.prototype, corrupting every object on the n8n page.
  // Null-prototype maps have no such key to hit.
  function dict(src) {
    var d = Object.create(null);
    if (src) Object.keys(src).forEach(function (k) { d[k] = src[k]; });
    return d;
  }

  function show(v, max) {
    max = max || 60;
    var s;
    try { s = JSON.stringify(v); } catch (e) { s = String(v); }
    if (s === undefined) s = 'undefined';
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  function asEmbeddedJson(s) {
    if (typeof s !== 'string' || s.length > 20000) return null;
    var t = s.trim();
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return null;
    try { var p = JSON.parse(t); return p && typeof p === 'object' ? p : null; } catch (e) { return null; }
  }

  function join(prefix, k) {
    if (!prefix) return k;
    return prefix.slice(-2) === '::' ? prefix + k : prefix + '.' + k;
  }

  var MAX_DEPTH = 24;

  function flatten(value, prefix, out, limit, depth) {
    if (limit === undefined) limit = 8;
    depth = depth || 0;
    // An API can hand back arbitrarily nested JSON. Without this, a deep
    // payload overflows the stack and takes the whole scan down with it -
    // which reads to the user as "nothing wrong here".
    if (depth > MAX_DEPTH) { out.push([prefix, '{...}', true]); return out; }
    if (typeof value === 'string') {
      var inner = asEmbeddedJson(value);
      if (inner) return flatten(inner, prefix + '::', out, limit, depth + 1);
      out.push([prefix, value]);
      return out;
    }
    if (value === null || typeof value !== 'object') { out.push([prefix, value]); return out; }
    if (Array.isArray(value)) {
      if (!value.length) { out.push([prefix, []]); return out; }
      if (value.length > limit) { out.push([prefix, '[' + value.length + ' items]', true]); return out; }
      for (var i = 0; i < value.length; i++) flatten(value[i], prefix + '[' + i + ']', out, limit, depth + 1);
      return out;
    }
    var keys = Object.keys(value);
    if (!keys.length) { out.push([prefix, {}]); return out; }
    if (keys.length > limit) { out.push([prefix, '{' + keys.length + ' fields}', true]); return out; }
    for (var j = 0; j < keys.length; j++) flatten(value[keys[j]], join(prefix, keys[j]), out, limit, depth + 1);
    return out;
  }

  function itemsOf(runData, name) {
    var runs = runData[name];
    if (!runs || !runs.length) return null;
    var items = [], stored = false;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (!r || !r.data || !r.data.main) continue;
      stored = true;
      for (var b = 0; b < r.data.main.length; b++) {
        if (r.data.main[b]) items = items.concat(r.data.main[b]);
      }
    }
    return stored ? items : null;
  }

  // Nodes whose whole job is to remove things. Emitting nothing is them
  // working, not them failing - flagging these is how a tool gets uninstalled.
  var REDUCERS = dict({
    'n8n-nodes-base.filter': 'filtered everything out',
    'n8n-nodes-base.removeDuplicates': 'found nothing new',
    'n8n-nodes-base.limit': 'kept nothing',
    'n8n-nodes-base.splitInBatches': 'finished looping',
    'n8n-nodes-base.compareDatasets': 'found no differences',
    'n8n-nodes-base.merge': 'merged to nothing',
    'n8n-nodes-base.if': 'sent nothing down either branch',
    'n8n-nodes-base.switch': 'matched no branch'
  });

  function nodeType(exec, name) {
    var nodes = (exec.workflowData && exec.workflowData.nodes) || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].name === name) return nodes[i].type || '';
    return '';
  }

  function hasUpstream(exec, name) {
    var conns = (exec.workflowData && exec.workflowData.connections) || {};
    for (var from in conns) {
      var mains = (conns[from] && conns[from].main) || [];
      for (var m = 0; m < mains.length; m++) {
        var b = mains[m] || [];
        for (var c = 0; c < b.length; c++) if (b[c] && b[c].node === name) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Two silent failures that have nothing to do with AI.
   *
   * Most of what this tool learned to spot needs a model in the loop, which
   * is no help at all to the majority of n8n workflows - Code, HTTP, Sheets,
   * Slack. These two are the ones that bite those workflows, and neither
   * shows up anywhere in n8n's UI.
   * ------------------------------------------------------------------ */

  // 1. A 200 response carrying an error. The HTTP node is perfectly happy -
  //    it got a response - and the API is telling you it refused. Rate limits,
  //    expired tokens and validation failures all arrive this way.
  var ERROR_KEYS = dict({
    error: 1, errors: 1, error_message: 1, errormessage: 1, error_description: 1,
    exception: 1, fault: 1, failure: 1
  });
  var NEGATIVE = dict({ error: 1, failed: 1, failure: 1, denied: 1, rejected: 1, unauthorized: 1 });

  function errorShaped(json) {
    if (!json || typeof json !== 'object') return null;
    var hit = null;
    Object.keys(json).slice(0, 60).forEach(function (k) {
      if (hit) return;
      var key = k.toLowerCase().replace(/[^a-z_]/g, '');
      var v = json[k];

      // { error: "rate limit exceeded" } - but not { error: null } or { errors: [] }
      if (ERROR_KEYS[key] && !isBlank(v)) {
        hit = { key: k, why: 'carries an error', value: show(v, 80) };
        return;
      }
      // { success: false } / { ok: false }
      if ((key === 'success' || key === 'ok' || key === 'succeeded') && v === false) {
        hit = { key: k, why: 'says it did not succeed', value: 'false' };
        return;
      }
      // { status: "failed" }
      if ((key === 'status' || key === 'state' || key === 'result') && typeof v === 'string'
          && NEGATIVE[v.toLowerCase().replace(/[^a-z]/g, '')]) {
        hit = { key: k, why: 'reports a failed state', value: show(v, 40) };
        return;
      }
      // { statusCode: 429 } inside a body the HTTP node treated as fine
      if ((key === 'statuscode' || key === 'status_code' || key === 'code')
          && typeof v === 'number' && v >= 400 && v <= 599) {
        hit = { key: k, why: 'carries an HTTP error code', value: String(v) };
      }
    });
    return hit;
  }

  function errorPayloads(exec) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var out = [];
    Object.keys(rd).forEach(function (name) {
      if (out.length >= 3) return;
      var items = itemsOf(rd, name);
      if (!items || !items.length) return;
      for (var i = 0; i < Math.min(items.length, 50); i++) {
        var hit = errorShaped(items[i] && items[i].json);
        if (hit) {
          out.push({ node: name, key: hit.key, why: hit.why, value: hit.value,
                     item: items.length > 1 ? i : null, total: items.length });
          return;
        }
      }
    });
    return out;
  }

  // 2. Items going missing partway through. Fifty rows in, forty-seven out -
  //    nobody notices three customers were dropped.
  //
  //    Only judged where the count MUST be preserved: an HTTP node runs once
  //    per item, and a Code node set to run once for each item does too. A
  //    Code node in its default mode legitimately turns fifty items into one,
  //    which is why this cannot simply compare every node.
  function itemLoss(exec) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var nodes = (exec.workflowData && exec.workflowData.nodes) || [];
    var byName = dict();
    nodes.forEach(function (n) { if (n && n.name) byName[n.name] = n; });

    var out = [];
    Object.keys(rd).forEach(function (name) {
      var def = byName[name];
      if (!def) return;
      var oneToOne = def.type === 'n8n-nodes-base.httpRequest'
        || (def.type === 'n8n-nodes-base.code'
            && def.parameters && def.parameters.mode === 'runOnceForEachItem');
      if (!oneToOne) return;

      var got = itemsOf(rd, name);
      if (!got) return;
      var up = upstreamOf(exec, name);
      var had = up ? itemsOf(rd, up) : null;
      if (!had || !had.length) return;
      if (got.length >= had.length) return;

      out.push({ node: name, from: up, had: had.length, got: got.length,
                 lost: had.length - got.length });
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Expressions pointing at fields that are not there.
   *
   * {{ $json.customer.email }} where the input has no `customer` does not
   * error. It resolves to nothing, the node runs, the field goes out blank,
   * and n8n marks the run successful. Rename a field upstream, or hit a
   * record shaped slightly differently, and a workflow starts writing empty
   * values into a CRM until somebody downstream complains.
   *
   * This is probably the most common silent failure in n8n, it has nothing to
   * do with AI, and nothing surfaces it. The workflow stores the expressions
   * and the run stores what actually arrived, so it can simply be checked.
   * ------------------------------------------------------------------ */

  // An expression that handles absence on purpose is not a bug. ||, ??, ?.,
  // a ternary or an explicit if() all mean the author already thought about
  // the field being missing.
  var HAS_FALLBACK = /\|\||\?\?|\?\.|\bif\s*\(|\?[^:]*:/;
  var MAX_REFS = 40;

  function normPath(s) {
    return String(s)
      .replace(/\[\s*['"]([^'"]+)['"]\s*\]/g, '.$1')
      .replace(/^\./, '')
      .split('.')
      .filter(Boolean);
  }

  function refsIn(src) {
    var out = [], m;
    // {{ $json.a.b }} and {{ $json["a"]["b"] }}
    var re = /\$json((?:\.[A-Za-z_$][\w$]*|\[\s*['"][^'"\]]+['"]\s*\])+)/g;
    while ((m = re.exec(src)) !== null && out.length < MAX_REFS) {
      out.push({ from: null, segs: normPath(m[1]), text: '$json' + m[1] });
    }
    // {{ $('Some Node').item.json.a.b }} - equally silent when wrong
    var re2 = /\$\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*(?:item|first\(\)|last\(\))\s*\.\s*json((?:\.[A-Za-z_$][\w$]*)+)/g;
    while ((m = re2.exec(src)) !== null && out.length < MAX_REFS) {
      out.push({ from: m[1], segs: normPath(m[2]), text: "$('" + m[1] + "')…json" + m[2] });
    }
    return out;
  }

  // How far down the path does this item get? Returns the number of segments
  // that resolved, so the report can say which one actually broke.
  function depthOn(json, segs) {
    var v = json, i = 0;
    for (; i < segs.length; i++) {
      if (v === null || v === undefined || typeof v !== 'object') break;
      if (!Object.prototype.hasOwnProperty.call(v, segs[i])) break;
      v = v[segs[i]];
    }
    return i;
  }

  function brokenRefs(exec, nodeName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var nodes = (exec.workflowData && exec.workflowData.nodes) || [];
    var def = null;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].name === nodeName) def = nodes[i];
    if (!def || !def.parameters) return [];

    var up = upstreamOf(exec, nodeName);
    var ownInput = up ? itemsOf(rd, up) : null;

    var out = [], seen = dict();

    flatten(def.parameters, '', [], 64).forEach(function (leaf) {
      if (out.length >= 4) return;
      var raw = typeof leaf[1] === 'string' ? leaf[1] : '';
      if (raw.indexOf('{{') === -1 && raw.charAt(0) !== '=') return;
      if (HAS_FALLBACK.test(raw)) return;              // absence already handled

      refsIn(raw).forEach(function (ref) {
        if (out.length >= 4) return;

        // Which items should this have resolved against?
        var against = ref.from ? itemsOf(rd, ref.from) : ownInput;
        // Nothing to check against is not evidence of anything.
        if (!against || !against.length) return;

        var best = 0;
        for (var k = 0; k < Math.min(against.length, 50); k++) {
          var d = depthOn(against[k] && against[k].json, ref.segs);
          if (d > best) best = d;
          if (best === ref.segs.length) return;         // resolves on some item
        }

        var key = String(leaf[0]) + '|' + ref.text;
        if (seen[key]) return;
        seen[key] = true;

        var missing = ref.segs[best];
        var parent = best === 0
          ? (ref.from ? '"' + ref.from + '"' : 'its input')
          : ref.segs.slice(0, best).join('.');

        out.push({
          param: String(leaf[0]) || '(parameter)',
          expr: ref.text,
          missing: missing,
          where: parent,
          resolvedDepth: best,
          items: against.length
        });
      });
    });

    return out;
  }

  // Every node in the run, not just the blamed one - a broken reference three
  // steps upstream is what produced the empty field you are staring at.
  function allBrokenRefs(exec) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var out = [];
    Object.keys(rd).forEach(function (name) {
      if (out.length >= 4) return;
      brokenRefs(exec, name).forEach(function (b) {
        if (out.length >= 4) return;
        b.node = name;
        out.push(b);
      });
    });
    return out;
  }

  // Which node do we blame? The one n8n flagged, or the first that quietly
  // emitted nothing.
  function blame(exec) {
    var res = (exec.data && exec.data.resultData) || {};
    var rd = res.runData || {};
    if (exec.status === 'error') {
      var err = res.error || {};
      return {
        name: (err.node && err.node.name) || res.lastNodeExecuted,
        why: 'failed', kind: 'failed', error: err
      };
    }
    var ordered = Object.keys(rd).map(function (n) {
      var runs = rd[n];
      return { name: n, idx: (runs && runs[0] && runs[0].executionIndex) || 0, items: itemsOf(rd, n) };
    }).sort(function (a, b) { return a.idx - b.idx; });

    for (var i = 0; i < ordered.length; i++) {
      var n = ordered[i];
      if (n.items === null) continue;

      if (!n.items.length) {
        var type = nodeType(exec, n.name);
        // A reducer emptying, or a trigger with nothing to hand on, is the
        // workflow behaving - report it as such, not as a fault.
        if (REDUCERS[type]) {
          return { name: n.name, why: REDUCERS[type], kind: 'filtered', error: null };
        }
        if (!hasUpstream(exec, n.name)) {
          return { name: n.name, why: 'had nothing to start from', kind: 'filtered', error: null };
        }
        return { name: n.name, why: 'produced 0 items', kind: 'broke', error: null };
      }

      var allBlank = true;
      for (var k = 0; k < n.items.length; k++) if (!isBlank(n.items[k].json)) { allBlank = false; break; }
      if (allBlank) return { name: n.name, why: 'produced empty output', kind: 'broke', error: null };
    }
    return null;
  }

  // Which node never ran as a result? Names the downstream victim for the list view.
  function skipped(exec, blamedName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var conns = (exec.workflowData && exec.workflowData.connections) || {};
    var outs = (conns[blamedName] && conns[blamedName].main) || [];
    for (var m = 0; m < outs.length; m++) {
      var branch = outs[m] || [];
      for (var c = 0; c < branch.length; c++) {
        if (branch[c] && branch[c].node && !rd[branch[c].node]) return branch[c].node;
      }
    }
    return null;
  }

  function upstreamOf(exec, name) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var runs = rd[name];
    if (runs && runs[0] && runs[0].source && runs[0].source[0] && runs[0].source[0].previousNode) {
      return runs[0].source[0].previousNode;
    }
    var conns = (exec.workflowData && exec.workflowData.connections) || {};
    for (var from in conns) {
      var mains = (conns[from] && conns[from].main) || [];
      for (var m = 0; m < mains.length; m++) {
        var branch = mains[m] || [];
        for (var c = 0; c < branch.length; c++) if (branch[c] && branch[c].node === name) return from;
      }
    }
    return null;
  }

  function expressions(exec, nodeName) {
    var nodes = (exec.workflowData && exec.workflowData.nodes) || [];
    var def = null;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].name === nodeName) def = nodes[i];
    if (!def || !def.parameters) return [];
    var hits = [];
    // Bounded, not Infinity: node parameters are workflow-supplied and a
    // pathological node would otherwise flatten into millions of leaves.
    flatten(def.parameters, '', [], 64).forEach(function (leaf) {
      var raw = typeof leaf[1] === 'string' ? leaf[1] : '';
      if (raw.indexOf('{{') !== -1 || raw.charAt(0) === '=') hits.push(leaf);
    });
    return hits.slice(0, 2);
  }

  /* ------------------------------------------------------------------ *
   * Provenance - claims the node could not have got from its input.
   *
   * Shape profiling catches output that looks wrong. It cannot catch output
   * where every field is present, correctly typed, plausibly formatted, and
   * simply invented. That is the expensive failure with a model in the loop:
   * "everything looks correct individually but it makes shit up".
   *
   * No judge model and no ground truth are needed for the damaging half of
   * it. n8n stores both sides of every node. If the output carries a phone
   * number, an email domain, an id or a link that appears nowhere in what
   * the node was handed, the model did not read that - it produced it.
   *
   * Deliberately restricted to tokens that should be COPIED rather than
   * composed. A summary is free to paraphrase; an account number is not.
   * ------------------------------------------------------------------ */

  var CLAIM_MIN_DIGITS = 6;   // below this it is a quantity, a price, a year
  var MAX_CLAIMS = 6;

  function haystack(items) {
    var parts = [];
    (items || []).slice(0, 200).forEach(function (i) {
      try { parts.push(JSON.stringify(i && i.json)); } catch (e) { /* skip */ }
    });
    return parts.join(' ').toLowerCase();
  }

  function claimsIn(json) {
    var out = [];
    flatten(json, '', [], 12).forEach(function (leaf) {
      if (typeof leaf[1] !== 'string') return;
      var s = leaf[1], m;

      // Email: compare the DOMAIN, never the whole address. Enrichment
      // legitimately composes first.last@domain from parts it was given, and
      // flagging that would be exactly the false positive that gets a tool
      // uninstalled. An unknown domain, though, was invented outright.
      var re = /[^\s@"']+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
      while ((m = re.exec(s)) !== null) {
        out.push({ kind: 'email domain', value: m[1], field: leaf[0], full: m[0] });
      }

      var reU = /https?:\/\/([A-Za-z0-9.-]+)/gi;
      while ((m = reU.exec(s)) !== null) {
        out.push({ kind: 'link', value: m[1], field: leaf[0], full: m[0] });
      }

      var reN = /\d[\d\s().-]{4,}\d/g;
      while ((m = reN.exec(s)) !== null) {
        var digits = m[0].replace(/\D/g, '');
        if (digits.length < CLAIM_MIN_DIGITS) continue;
        out.push({ kind: 'number', value: digits, field: leaf[0], full: m[0].trim() });
      }
    });
    return out;
  }

  /* ---- AI root nodes ----------------------------------------------------
   *
   * An Agent's real context does not arrive down its main input. The model
   * sees whatever its tools returned, whatever memory held, and whatever a
   * vector store retrieved - all of which n8n stores on the SUB-nodes, under
   * channels like ai_tool and ai_memory rather than main.
   *
   * Checking an agent's output against its main input alone would therefore
   * call every correctly-retrieved fact an invention. Any RAG or tool-using
   * agent would light up red on its first run.
   *
   * The channel names are read from the data rather than hardcoded: n8n keeps
   * adding connection types, and a list baked in here would silently go stale
   * and start producing exactly the false positives it was meant to prevent.
   */
  function itemsAnyChannel(runData, name) {
    var runs = runData[name];
    if (!runs || !runs.length) return null;
    var items = [], stored = false;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      if (!r || !r.data) continue;
      var channels = Object.keys(r.data);
      for (var c = 0; c < channels.length; c++) {
        var branches = r.data[channels[c]];
        if (!Array.isArray(branches)) continue;
        stored = true;
        for (var b = 0; b < branches.length; b++) {
          if (Array.isArray(branches[b])) items = items.concat(branches[b]);
        }
      }
    }
    return stored ? items : null;
  }

  // Sub-nodes wired into this node by anything other than a main connection.
  function helpersOf(exec, nodeName) {
    var conns = (exec.workflowData && exec.workflowData.connections) || {};
    var out = [];
    Object.keys(conns).forEach(function (from) {
      var byType = conns[from] || {};
      Object.keys(byType).forEach(function (type) {
        if (type === 'main') return;
        (byType[type] || []).forEach(function (branch) {
          (branch || []).forEach(function (link) {
            if (link && link.node === nodeName) out.push({ name: from, type: type });
          });
        });
      });
    });
    return out;
  }

  // Everything the node could legitimately have drawn on.
  function contextFor(exec, nodeName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var ctx = [];

    var up = upstreamOf(exec, nodeName);
    var main = up ? itemsOf(rd, up) : null;
    if (main) ctx = ctx.concat(main);

    helpersOf(exec, nodeName).forEach(function (h) {
      var got = itemsAnyChannel(rd, h.name);
      if (got) ctx = ctx.concat(got);
    });

    // The agent's own intermediate steps hold the tool observations it acted
    // on. Those are retrieved context, not invention.
    var own = itemsOf(rd, nodeName) || [];
    own.forEach(function (it) {
      var steps = it && it.json && it.json.intermediateSteps;
      if (Array.isArray(steps)) ctx.push({ json: steps });
    });

    return ctx;
  }

  // Only a model can "make something up". A Code node that mints an order id,
  // or an HTTP node returning a reference number, is behaving normally - and
  // asking where those digits came from produces an alert on nearly every
  // healthy run. So provenance applies to nodes whose text a model wrote, and
  // to nothing else.
  var AI_HINT = /langchain|openai|anthropic|cohere|mistral|ollama|llm|agent|chatmodel/i;

  function isModelNode(exec, nodeName) {
    if (AI_HINT.test(nodeType(exec, nodeName))) return true;
    // Whatever it is called, a node with a language model wired into it is
    // producing model output.
    var helpers = helpersOf(exec, nodeName);
    for (var i = 0; i < helpers.length; i++) {
      if (/languageModel|Model$/i.test(helpers[i].type)) return true;
    }
    return false;
  }

  function provenance(exec, nodeName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var items = itemsOf(rd, nodeName);
    if (!items || !items.length) return [];
    if (!isModelNode(exec, nodeName)) return [];

    var input = contextFor(exec, nodeName);
    // With nothing to compare against, say nothing. A check that did not run
    // must never read as a clean bill of health.
    if (!input || !input.length) return [];

    var hay = haystack(input);
    if (!hay) return [];
    var hayDigits = hay.replace(/\D/g, '');

    var miss = [], seen = dict();
    items.slice(0, 50).forEach(function (it) {
      claimsIn(it && it.json).forEach(function (c) {
        var v = String(c.value).toLowerCase();
        if (!v || seen[v]) return;
        var found;
        if (c.kind === 'number') {
          // Digits are compared stripped, so "+44 161 555 0123" in the input
          // covers "441615550123" in the output.
          found = hayDigits.indexOf(v) !== -1;
          // A phone number moving between international and national form -
          // +44 161 555 0123 becoming (0161) 555-0123 - shares only its tail,
          // because the trunk zero replaces the country code. Matching the
          // last seven digits keeps that legitimate rewrite from reading as an
          // invention. The cost is the occasional missed short id, which is
          // the right way round: a false alarm here is what gets this muted.
          if (!found && v.length >= 7) found = hayDigits.indexOf(v.slice(-7)) !== -1;
        } else {
          found = hay.indexOf(v) !== -1;
        }
        if (found) return;
        seen[v] = true;
        miss.push(c);
      });
    });
    return miss.slice(0, MAX_CLAIMS);
  }

  /* ------------------------------------------------------------------ *
   * Run against previous run.
   *
   * Everything else here answers "is something broken", which is a question
   * people ask rarely. While actually building a workflow they hit Execute
   * dozens of times a day and ask a different one: did that change help?
   *
   * n8n answers it with a JSON tree and no memory of the last run, so the
   * comparison happens in the builder's head. This does it properly: two
   * executions of the same workflow, field by field.
   *
   * Deliberately NOT the drift profile. That learns "normal" over many runs
   * and is the right tool for a silent regression in production. This is the
   * opposite - the immediately previous run, no history needed, useful on the
   * second execution of a workflow that is ten minutes old.
   * ------------------------------------------------------------------ */

  var TEXT_SHIFT = 0.25;    // report a text length move beyond this fraction

  function leafMap(items) {
    var map = dict();
    if (!items || !items.length) return map;
    flatten(items[0] && items[0].json, '', [], 12).forEach(function (leaf) {
      map[String(leaf[0])] = leaf[1];
    });
    return map;
  }

  function compareRuns(prev, curr) {
    var pNode = resultNode(prev), cNode = resultNode(curr);
    var pItems = pNode ? resultItems(prev, pNode) : null;
    var cItems = cNode ? resultItems(curr, cNode) : null;

    var changes = [];

    // Item count first: 50 rows becoming 3 matters more than any field.
    var pn = pItems ? pItems.length : 0;
    var cn = cItems ? cItems.length : 0;
    if (pn !== cn) {
      changes.push({ field: '(item count)', kind: 'count', was: String(pn), now: String(cn) });
    }
    // When the workflow stops producing where it used to, the result node
    // falls back to an earlier one - and diffing that node's fields against
    // the old one's compares two unrelated shapes. Every field reads as
    // "gone", burying the single fact that matters: it stopped at a different
    // place. Report the move and say nothing else.
    if (pNode !== cNode) {
      changes.unshift({ field: '(last node with output)', kind: 'moved',
                        was: String(pNode || 'nothing'), now: String(cNode || 'nothing') });
      return { node: cNode, changes: changes, identical: false, nodeMoved: true };
    }

    var a = leafMap(pItems), b = leafMap(cItems);
    var keys = [], seenKey = dict();
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) {
      if (!seenKey[k]) { seenKey[k] = true; keys.push(k); }
    });

    keys.forEach(function (k) {
      var was = a[k], now = b[k];
      var hadIt = k in a, hasIt = k in b;

      if (hadIt && !hasIt) {
        changes.push({ field: k, kind: 'gone', was: show(was, 40), now: '—' });
        return;
      }
      if (!hadIt && hasIt) {
        changes.push({ field: k, kind: 'new', was: '—', now: show(now, 40) });
        return;
      }
      if (isBlank(was) && !isBlank(now)) {
        changes.push({ field: k, kind: 'filled', was: 'empty', now: show(now, 40) });
        return;
      }
      if (!isBlank(was) && isBlank(now)) {
        changes.push({ field: k, kind: 'emptied', was: show(was, 40), now: 'empty' });
        return;
      }
      if (typeOf(was) !== typeOf(now)) {
        changes.push({ field: k, kind: 'type', was: typeOf(was), now: typeOf(now) + ' ' + show(now, 30) });
        return;
      }
      if (typeof was === 'string' && typeof now === 'string') {
        if (was === now) return;
        // Long text rewords on every run of anything with a model in it.
        // Reporting the whole string as "changed" would drown the real
        // signal, so past a certain length only a size move is worth saying.
        if (was.length > 80 || now.length > 80) {
          var shift = Math.abs(now.length - was.length) / Math.max(1, was.length);
          if (shift >= TEXT_SHIFT) {
            changes.push({ field: k, kind: now.length < was.length ? 'shorter' : 'longer',
                           was: was.length + ' chars', now: now.length + ' chars: ' + show(now, 50) });
          }
          return;
        }
        changes.push({ field: k, kind: 'changed', was: show(was, 40), now: show(now, 40) });
        return;
      }
      if (was !== now) {
        changes.push({ field: k, kind: 'changed', was: show(was, 40), now: show(now, 40) });
      }
    });

    return { node: cNode, changes: changes, identical: changes.length === 0 };
  }

  /* ------------------------------------------------------------------ *
   * Diagnosis - which KIND of wrong.
   *
   * From a user describing how he debugs an agent by hand: "that usually
   * helps pinpoint whether it's hallucinating, using bad context, or just
   * making the wrong decision from correct data."
   *
   * Those three branches need different fixes - a retrieval bug, a prompt
   * bug, and a model bug are not the same afternoon of work - and knowing
   * which one you are in is most of the job. n8n stores everything needed to
   * separate them: the ask, what came back from the tools, and the answer.
   *
   * The third branch is the honest limit. "Correct data, wrong conclusion"
   * needs to know the right answer. What IS detectable is the subset where
   * the answer contradicts its own source - every field plausible, one of
   * them disagreeing with the document it came from.
   * ------------------------------------------------------------------ */

  var ID_RE = /\b[A-Z][A-Z0-9]{1,}-\d{2,}\b/g;      // INV-8842, ACC-88421905
  var NUM_RE = /\b\d{4,}\b/g;                        // order numbers, ids
  var MAIL_RE = /[^\s@"']+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  var URL_RE = /https?:\/\/[^\s"',]+/g;

  function isYear(s) {
    var n = Number(s);
    return s.length === 4 && n >= 1900 && n <= 2100;
  }

  // The specifics a request is *about*. Common words are useless here - only
  // things that must appear verbatim if the right record was found.
  function distinctiveTokens(items) {
    var text = haystack(items);
    var raw = [];
    [ID_RE, NUM_RE, MAIL_RE, URL_RE].forEach(function (re) {
      re.lastIndex = 0;
      var m;
      while ((m = re.exec(text)) !== null) raw.push(m[0]);
    });
    var out = dict(), list = [];
    raw.forEach(function (t) {
      var k = String(t).toLowerCase();
      if (isYear(k)) return;
      if (out[k]) return;
      out[k] = true;
      list.push(k);
    });
    return list;
  }

  // Main input versus what the sub-nodes actually returned. contextFor() folds
  // these together, which is right for grounding and wrong here: the whole
  // question is whether the retrieval covered the ask.
  function splitContext(exec, nodeName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var up = upstreamOf(exec, nodeName);
    var ask = (up ? itemsOf(rd, up) : null) || [];

    var retrieved = [], failedTools = [], toolNodes = 0;
    helpersOf(exec, nodeName).forEach(function (h) {
      // A language model is not a source of facts - it is the thing being
      // checked. Only tools, retrievers, vector stores and memory count.
      if (/languageModel|outputParser/i.test(h.type)) return;
      toolNodes++;
      var runs = rd[h.name] || [];
      var errored = runs.some(function (r) { return r && r.error; });
      if (errored) failedTools.push(h.name);
      var got = itemsAnyChannel(rd, h.name);
      if (got) retrieved = retrieved.concat(got);
    });

    // Observations inside intermediateSteps are retrieved context too, and on
    // a default-configured agent they are the only record of a tool result.
    (itemsOf(rd, nodeName) || []).forEach(function (it) {
      var steps = it && it.json && it.json.intermediateSteps;
      if (!Array.isArray(steps)) return;
      if (!toolNodes) toolNodes = steps.length ? 1 : 0;
      steps.forEach(function (s) {
        if (s && s.observation !== undefined) retrieved.push({ json: s.observation });
      });
    });

    return { ask: ask, retrieved: retrieved, toolNodes: toolNodes, failedTools: failedTools };
  }

  function norm(v) {
    return String(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  // Leaf field name -> every value seen under it. Keyed on the last path
  // segment so item[3].tier and tier are the same field.
  function fieldValues(items) {
    var map = dict();
    (items || []).slice(0, 100).forEach(function (it) {
      flatten(it && it.json, '', [], 12).forEach(function (leaf) {
        var v = leaf[1];
        if (v === null || v === undefined || typeof v === 'object') return;
        var s = String(v);
        // Free text cannot contradict anything usefully, and one-character
        // values collide with everything.
        if (s.length < 2 || s.length > 60) return;
        var path = String(leaf[0]);
        var key = path.split(/[.:]/).pop().replace(/\[\d*\]/g, '');
        if (!key) return;
        (map[key] = map[key] || []).push(norm(s));
      });
    });
    return map;
  }

  function diagnose(exec, nodeName) {
    if (!isModelNode(exec, nodeName)) return null;
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var answer = itemsOf(rd, nodeName);
    if (!answer || !answer.length) return null;

    var split = splitContext(exec, nodeName);

    // 1. A tool blew up and the agent answered anyway. Root cause, not a
    //    symptom - everything downstream of this is explained by it.
    if (split.failedTools.length) {
      return {
        branch: 'bad context',
        why: 'a tool it depends on failed, and it answered anyway',
        evidence: split.failedTools.map(function (n) { return n + ' errored'; })
      };
    }

    // 2. Tools were wired in and returned nothing at all.
    if (split.toolNodes && !split.retrieved.length) {
      return {
        branch: 'bad context',
        why: 'nothing came back from its tools, and it answered anyway',
        evidence: ['no retrieved context in this run']
      };
    }

    // 3. The ask names specifics the retrieval never found. Only judged when
    //    there was retrieval to judge and the ask HAS specifics - otherwise
    //    the check has not run and must say nothing.
    if (split.toolNodes && split.retrieved.length) {
      var wanted = distinctiveTokens(split.ask);
      if (wanted.length) {
        var have = haystack(split.retrieved);
        var haveDigits = have.replace(/\D/g, '');
        var missed = wanted.filter(function (t) {
          if (/^\d+$/.test(t)) return haveDigits.indexOf(t) === -1;
          return have.indexOf(t) === -1;
        });
        if (missed.length === wanted.length) {
          return {
            branch: 'bad context',
            why: 'what it was asked about never appears in what it retrieved',
            evidence: missed.slice(0, 4).map(function (t) { return '"' + t + '" not in any retrieved document'; })
          };
        }
      }
    }

    // 4. The answer disagrees with its own source. This is the detectable
    //    slice of "everything looks correct individually": each field is
    //    plausible, one of them contradicts the record it came from.
    var ctxAll = split.ask.concat(split.retrieved);
    if (ctxAll.length) {
      var ctxVals = fieldValues(ctxAll);
      var ansVals = fieldValues(answer);
      var clashes = [];
      Object.keys(ansVals).forEach(function (k) {
        var known = ctxVals[k];
        if (!known || !known.length) return;          // field not in the source
        // Many records may share a field; matching ANY of them is fine.
        ansVals[k].forEach(function (v) {
          if (!v || known.indexOf(v) !== -1) return;
          if (known.length > 12) return;              // too varied to judge
          clashes.push(k + ' = ' + v + ', but its source says '
            + known.slice(0, 3).join(' / '));
        });
      });
      if (clashes.length) {
        return {
          branch: 'wrong decision',
          why: 'the answer contradicts the data it was given',
          evidence: clashes.slice(0, 3)
        };
      }
    }

    // 5. Facts in the answer that came from nowhere.
    var invented = provenance(exec, nodeName);
    if (invented.length) {
      return {
        branch: 'hallucinated',
        why: 'the answer contains details that appear in nothing it was given',
        evidence: invented.slice(0, 3).map(function (c) {
          return c.field + ': ' + c.full + ' (' + c.kind + ')';
        })
      };
    }

    return null;
  }

  /* ---- the backwards trace ----------------------------------------------
   *
   * "I trace it backwards: what context it received, what it retrieved, which
   * tools it called, and what instructions it followed." That is the slow
   * step, done by hand, through nested JSON. n8n has all of it already.
   *
   * Two sources, because either can be absent: the agent's own
   * intermediateSteps (only present when Return Intermediate Steps is on),
   * and the sub-nodes' own stored runs (always there if the node ran).
   */
  function summarise(v, max) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.length > max ? v.slice(0, max) + '…' : v;
    return show(v, max);
  }

  function agentTrace(exec, nodeName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var steps = [];

    (itemsOf(rd, nodeName) || []).forEach(function (it) {
      var list = it && it.json && it.json.intermediateSteps;
      if (!Array.isArray(list)) return;
      list.slice(0, 20).forEach(function (s) {
        var a = (s && s.action) || {};
        steps.push({
          from: 'step',
          tool: a.tool || a.toolName || 'unknown tool',
          input: summarise(a.toolInput !== undefined ? a.toolInput : a.input, 120),
          output: summarise(s && s.observation, 200)
        });
      });
    });

    // Sub-nodes that actually ran. Reported even when intermediateSteps is
    // missing, which is the common case - the option is off by default, and
    // it is also dropped entirely when streaming is enabled.
    helpersOf(exec, nodeName).forEach(function (h) {
      var runs = rd[h.name];
      if (!runs || !runs.length) return;
      var got = itemsAnyChannel(rd, h.name) || [];
      steps.push({
        from: 'node',
        tool: h.name,
        kind: String(h.type).replace(/^ai_/, ''),
        calls: runs.length,
        output: got.length ? summarise(got[0] && got[0].json, 200) : '(nothing stored)'
      });
    });

    return steps;
  }

  // An Execute Workflow node that returns nothing is NOT a payload problem -
  // the cause is inside the child workflow. Pointing at the parent's webhook
  // fields here would be actively misleading.
  function subWorkflow(exec, nodeName) {
    var nodes = (exec.workflowData && exec.workflowData.nodes) || [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.name !== nodeName) continue;
      if (n.type !== 'n8n-nodes-base.executeWorkflow') return null;
      var w = n.parameters && n.parameters.workflowId;
      if (!w) return { id: null, name: null };
      if (typeof w === 'string') return { id: w, name: null };
      return { id: w.value || null, name: w.cachedResultName || null };
    }
    return null;
  }

  function analyze(exec) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var target = blame(exec);
    if (!target || !target.name) return { clean: true };

    var sub = subWorkflow(exec, target.name);
    if (sub && target.why !== 'failed') {
      return {
        clean: false, target: target, err: {}, exprs: [], keys: [], context: [],
        from: null, items: null, total: 0,
        skipped: skipped(exec, target.name), sub: sub
      };
    }

    var err = target.error || {};
    var errText = [err.message, err.description].filter(Boolean).join(' ');
    var exprs = expressions(exec, target.name);
    var up = upstreamOf(exec, target.name);
    var items = up ? itemsOf(rd, up) : null;
    var keys = [], context = [];
    var total = items ? items.length : 0;

    if (items && items.length) {
      var scan = Math.min(total, 200);
      var leaves = [];
      for (var i = 0; i < scan; i++) flatten(items[i].json, total > 1 ? 'item[' + i + ']' : '', leaves);

      var hits = [], blanks = [];
      leaves.forEach(function (leaf) {
        var raw = typeof leaf[1] === 'string' ? leaf[1] : '';
        if (raw.length > 3 && errText && errText.indexOf(raw) !== -1) hits.push(leaf);
        else if (!leaf[2] && isBlank(leaf[1])) blanks.push(leaf);
        else context.push(leaf);
      });

      function group(list, label) {
        var by = dict(), order = [];
        list.forEach(function (l) {
          var k = String(l[0]).replace(/\[\d+\]/g, '[]');
          if (!by[k]) { by[k] = { path: k, first: l, n: 0 }; order.push(k); }
          by[k].n++;
        });
        return order.map(function (k) {
          var g = by[k];
          if (total <= 1) return [[g.path, g.first[1], g.first[2]], label];
          if (g.n === 1) return [[g.first[0], g.first[1], g.first[2]], label + ' (1 of ' + total + ' items)'];
          return [[g.path, g.first[1], g.first[2]], label + ' in ' + g.n + ' of ' + total + ' items'];
        });
      }

      keys = group(hits, 'appears in the error');
      if (target.why !== 'failed' || (!keys.length && !exprs.length)) {
        keys = keys.concat(group(blanks, 'empty'));
      } else {
        context = context.concat(blanks);
      }

      var ctxBy = dict(), ctxOrder = [];
      context.forEach(function (c) {
        var k = String(c[0]).replace(/\[\d+\]/g, '[]');
        if (!ctxBy[k]) { ctxBy[k] = [k, c[1], c[2]]; ctxOrder.push(k); }
      });
      var seen = dict();
      context = ctxOrder.map(function (k) { return ctxBy[k]; }).filter(function (c) {
        var top = String(c[0]).split(/[.[:]/)[0];
        seen[top] = (seen[top] || 0) + 1;
        return seen[top] <= 2;
      }).slice(0, 4);
    }

    return {
      clean: false, target: target, err: err, exprs: exprs, keys: keys,
      context: context, from: up, items: items, total: total,
      skipped: target.why !== 'failed' ? skipped(exec, target.name) : null
    };
  }

  // One-line verdict for the executions list.
  //   kind: 'error'    - n8n already told you
  //         'silent'   - reports success, produced nothing, should not have
  //         'filtered' - produced nothing on purpose (Filter, dedupe, no input)
  function verdict(exec) {
    var r = analyze(exec);
    if (r.clean) return null;
    if (r.target.why === 'failed') {
      return {
        kind: 'error', node: r.target.name,
        text: r.target.name + ' failed' + (r.err.httpCode ? ' (' + r.err.httpCode + ')' : '')
      };
    }
    if (r.sub) {
      return {
        kind: 'silent', node: r.target.name, key: null, sub: r.sub,
        text: r.target.name + ' returned nothing from sub-workflow'
      };
    }
    if (r.target.kind === 'filtered') {
      return {
        kind: 'filtered', node: r.target.name,
        text: r.target.name + ' ' + r.target.why + (r.skipped ? ' → ' + r.skipped + ' never ran' : '')
      };
    }
    // Naming the empty key is the whole point of the tool, so it belongs in
    // the one-line verdict. "Push to CRM never ran" is the symptom three nodes
    // downstream; "extraction was empty" is the thing you go and fix.
    var key = null, klabel = '';
    if (r.keys.length) { key = r.keys[0][0][0]; klabel = String(r.keys[0][1]); }

    var text;
    if (key && klabel.indexOf('empty') === 0) {
      text = key + ' ' + klabel.replace(/^empty/, 'was empty')
           + ' → ' + r.target.name + ' produced nothing';
    } else if (r.skipped) {
      text = r.target.name + ' ' + r.target.why + ' → ' + r.skipped + ' never ran';
    } else {
      text = r.target.name + ' ' + r.target.why;
    }
    return { kind: 'silent', text: text, node: r.target.name, key: key };
  }

  var REPLAY_METHODS = dict({ GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, HEAD: 1 });

  // The webhook path comes out of workflowData, which is not trusted: n8n
  // templates are shared and imported freely, and in a shared workspace someone
  // else wrote the node you are debugging. A path of "../rest/workflows" would
  // turn the Replay button into a one-click CSRF against the user's own n8n,
  // authenticated with their session cookie, on a same-origin fetch. So the
  // final URL is resolved and then checked to still be under /webhook/.
  function webhookUrl(origin, rawPath) {
    var clean = String(rawPath === undefined || rawPath === null ? '' : rawPath).trim();
    if (!clean || clean.length > 512) return null;
    if (/[?#\\]/.test(clean)) return null;

    var decoded = clean;
    try { decoded = decodeURIComponent(clean); } catch (e) { return null; }
    if (decoded.indexOf('..') !== -1) return null;

    var base, url;
    try {
      base = new URL(origin);
      url = new URL('/webhook/' + clean.replace(/^\/+/, ''), base);
    } catch (e) { return null; }

    if (url.origin !== base.origin) return null;
    if (url.pathname.indexOf('/webhook/') !== 0) return null;
    return url.href;
  }

  function replayTarget(exec, origin) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var nodes = (exec.workflowData && exec.workflowData.nodes) || [];
    var hook = null;
    for (var i = 0; i < nodes.length; i++) if (nodes[i].type === 'n8n-nodes-base.webhook') hook = nodes[i];
    if (!hook) return null;
    var items = itemsOf(rd, hook.name);
    if (!items || !items.length) return null;
    var p = hook.parameters || {};

    var url = webhookUrl(origin, p.path);
    if (!url) return null;

    var method = String(p.httpMethod || 'POST').toUpperCase();
    if (!REPLAY_METHODS[method]) method = 'POST';

    var payload = items[0].json || {};
    return { url: url, method: method, body: payload.body === undefined ? {} : payload.body };
  }

  // n8n may hand back "flatted" (index-referenced) execution data.
  function unflatten(arr) {
    if (!Array.isArray(arr)) return arr;
    var seen = {};
    function ref(v) {
      if (typeof v !== 'string') return v;
      var i = Number(v);
      return (String(i) === v && i >= 0 && i < arr.length) ? node(i) : v;
    }
    function node(i) {
      if (seen[i] !== undefined) return seen[i];
      var raw = arr[i];
      if (raw === null || typeof raw !== 'object') { seen[i] = raw; return raw; }
      var out = Array.isArray(raw) ? [] : {};
      seen[i] = out;
      if (Array.isArray(raw)) raw.forEach(function (v) { out.push(ref(v)); });
      else Object.keys(raw).forEach(function (k) { out[k] = ref(raw[k]); });
      return out;
    }
    return node(0);
  }

  function normalise(raw) {
    var exec = (raw && raw.data && raw.data.resultData) ? raw : (raw && raw.data) ? raw.data : raw;
    if (exec && typeof exec.data === 'string') {
      try {
        var parsed = JSON.parse(exec.data);
        exec.data = Array.isArray(parsed) ? unflatten(parsed) : parsed;
      } catch (e) { /* leave it; caller reports */ }
    }
    return exec;
  }

  /* ------------------------------------------------------------------ *
   * Output shape profiling - "confidently wrong" detection.
   *
   * An empty output is easy. The expensive failures are the ones that come
   * back populated and plausible: an LLM answering "I'm sorry, I can't help
   * with that" where JSON should be, a field that silently became null, an
   * extraction that collapsed from 200 characters to 12.
   *
   * No judge model is needed for that, and no SDK wrapping either. n8n has
   * already stored what this node's output normally looks like. Learn the
   * shape from the runs that were fine, then flag the run that breaks it.
   * ------------------------------------------------------------------ */

  var MIN_PROFILE_RUNS = 8;     // below this, "normal" is not established
  var MAX_ENUM = 6;             // a field with few distinct values is a set
  var LEN_COLLAPSE = 0.4;       // 40% of the shortest ever seen
  var MAX_FIELDS = 64;          // payload width is attacker-controlled

  var FORMATS = dict({
    email: /^[^@\s]+@[^@\s.]+\.[^@\s]+$/,
    url: /^https?:\/\/[^\s]+$/i,
    isoDate: /^\d{4}-\d{2}-\d{2}([T ]|$)/
  });
  var FORMAT_NAMES = Object.keys(FORMATS);

  // Ranked by how sharply the finding points at a cause. A type flip or a
  // field that was never empty going empty is unambiguous; a number drifting
  // out of its usual band is the softest signal here.
  var DRIFT_RANK = { type: 0, empty: 1, format: 2, unexpected: 3, shrank: 4, range: 5 };
  var BIG_DROP = 50;

  function rankOf(d) {
    var r = DRIFT_RANK[d.kind];
    if (r === undefined) r = 9;
    // A text field that lost most of its body outranks everything but an
    // outright type flip: it carries the refusal or the truncation verbatim,
    // which is the line that makes the cause obvious to a human. Ranking it
    // by kind alone buries it under the consequences it caused.
    if (d.kind === 'shrank' && (d.drop || 0) >= BIG_DROP) r = 0.5;
    return r;
  }

  function typeOf(v) {
    if (v === null || v === undefined) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function formatsOf(v) {
    var out = [];
    if (typeof v === 'string') {
      FORMAT_NAMES.forEach(function (f) { if (FORMATS[f].test(v)) out.push(f); });
    }
    return out;
  }

  // Fold one item's json into a profile. Call once per clean run.
  function addToProfile(profile, json) {
    profile = profile || { runs: 0, fields: dict() };
    profile.runs++;
    if (!json || typeof json !== 'object') return profile;

    Object.keys(json).slice(0, MAX_FIELDS).forEach(function (k) {
      var v = json[k];
      var f = profile.fields[k];
      if (!f) {
        // Runs need not share a schema, so cap the total too - otherwise a
        // node emitting dynamic keys grows this map on every single run.
        if (Object.keys(profile.fields).length >= MAX_FIELDS) return;
        f = profile.fields[k] = {
          seen: 0, filled: 0, types: dict(), values: dict(), distinct: 0,
          lenMin: null, lenMax: null, numMin: null, numMax: null, formats: dict()
        };
      }
      f.seen++;
      if (!isBlank(v)) f.filled++;

      var t = typeOf(v);
      f.types[t] = (f.types[t] || 0) + 1;

      if (typeof v === 'string') {
        f.lenMin = f.lenMin === null ? v.length : Math.min(f.lenMin, v.length);
        f.lenMax = f.lenMax === null ? v.length : Math.max(f.lenMax, v.length);
        if (f.distinct <= MAX_ENUM) {
          if (f.values[v] === undefined) { f.values[v] = 0; f.distinct = Object.keys(f.values).length; }
          f.values[v]++;
        }
        formatsOf(v).forEach(function (fmt) { f.formats[fmt] = (f.formats[fmt] || 0) + 1; });
      } else if (typeof v === 'number' && isFinite(v)) {
        f.numMin = f.numMin === null ? v : Math.min(f.numMin, v);
        f.numMax = f.numMax === null ? v : Math.max(f.numMax, v);
      }
    });
    return profile;
  }

  function dominantType(f) {
    var best = null, n = 0, total = 0;
    for (var t in f.types) { total += f.types[t]; if (f.types[t] > n) { n = f.types[t]; best = t; } }
    return (total && n / total >= 0.9) ? best : null;
  }

  // What does this item break, compared with what the node normally emits?
  // Every rule needs the field to have been consistent BEFORE, so a field that
  // was always varied never trips anything.
  // opts.pooled - the profile was built from SEVERAL workflows rather than
  // this node's own past. Different workflows legitimately emit different
  // field sets, so an absent field means "this one does not use it", not
  // "it went empty". Judging absence against a pooled profile flags healthy
  // workflows for the crime of being different, which is worse than useless.
  function driftAgainst(profile, json, opts) {
    var out = [];
    if (!profile || profile.runs < MIN_PROFILE_RUNS || !json || typeof json !== 'object') return out;
    var pooled = !!(opts && opts.pooled);

    Object.keys(profile.fields).forEach(function (k) {
      var f = profile.fields[k];
      if (f.seen < profile.runs) return;             // not always present: skip entirely
      if (pooled && !(k in json)) return;            // different schema, not a fault
      var v = json[k];

      // 1. always filled, now empty
      if (f.filled === f.seen && isBlank(v)) {
        out.push({ field: k, kind: 'empty', was: 'always filled', now: show(v, 30) });
        return;
      }
      if (isBlank(v)) return;

      // 2. type changed
      var dom = dominantType(f);
      var t = typeOf(v);
      if (dom && t !== dom) {
        out.push({ field: k, kind: 'type', was: dom, now: t + ' ' + show(v, 30) });
        return;
      }

      if (typeof v === 'string') {
        // 3. a value outside a small, stable set
        if (f.distinct > 0 && f.distinct <= MAX_ENUM && f.values[v] === undefined) {
          out.push({
            field: k, kind: 'unexpected',
            was: 'only ever ' + Object.keys(f.values).map(function (s) { return JSON.stringify(s); }).join(', '),
            now: show(v, 40)
          });
          return;
        }
        // 4. format broke. Checked BEFORE length: "was always a valid email,
        // now \"unknown\"" says more than "shrank from 33 chars to 7".
        var broke = null;
        FORMAT_NAMES.forEach(function (fmt) {
          if (broke) return;
          if (f.formats[fmt] === f.seen && !FORMATS[fmt].test(v)) broke = fmt;
        });
        if (broke) {
          out.push({ field: k, kind: 'format', was: 'always a valid ' + broke, now: show(v, 40) });
          return;
        }
        // 5. text collapsed - the classic "I'm sorry, I cannot..." reply
        if (f.lenMin !== null && f.lenMin >= 25 && v.length < Math.floor(f.lenMin * LEN_COLLAPSE)) {
          out.push({
            field: k, kind: 'shrank', drop: f.lenMin - v.length,
            was: 'normally ' + f.lenMin + '-' + f.lenMax + ' chars',
            now: v.length + ' chars: ' + show(v, 60)
          });
          return;
        }
      } else if (typeof v === 'number' && f.numMin !== null) {
        // 6. numeric well outside the observed band
        var span = f.numMax - f.numMin;
        var pad = span > 0 ? span : Math.max(1, Math.abs(f.numMax) * 0.5);
        if (v < f.numMin - pad || v > f.numMax + pad) {
          out.push({
            field: k, kind: 'range',
            was: 'normally ' + f.numMin + '-' + f.numMax, now: String(v)
          });
          return;
        }
      }
    });

    // Field order in the payload is arbitrary, so the first drift found is not
    // the most useful one to show. A contact_email collapsing to "unknown" and
    // a summary collapsing to "I'm sorry, I can't help with that" are both
    // 'shrank' - the second is the one that explains the run. Rank by how much
    // the finding narrows down the cause, then by how much text was lost.
    out.sort(function (a, b) {
      var d = rankOf(a) - rankOf(b);
      if (d) return d;
      return (b.drop || 0) - (a.drop || 0);
    });
    return out;
  }

  // Which node's output should we profile? The last one that produced items -
  // that is the workflow's actual result.
  function resultNode(exec) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    var best = null, bestIdx = -1;
    Object.keys(rd).forEach(function (n) {
      var items = itemsOf(rd, n);
      if (!items || !items.length) return;
      var idx = (rd[n][0] && rd[n][0].executionIndex) || 0;
      if (idx >= bestIdx) { bestIdx = idx; best = n; }
    });
    return best;
  }

  function resultItems(exec, nodeName) {
    var rd = (exec.data && exec.data.resultData && exec.data.resultData.runData) || {};
    return itemsOf(rd, nodeName);
  }

  root.WHY_ENGINE = {
    analyze: analyze, verdict: verdict, replayTarget: replayTarget,
    normalise: normalise, show: show, isBlank: isBlank,
    addToProfile: addToProfile, driftAgainst: driftAgainst,
    resultNode: resultNode, resultItems: resultItems,
    provenance: provenance, agentTrace: agentTrace, helpersOf: helpersOf,
    contextFor: contextFor, isModelNode: isModelNode,
    diagnose: diagnose, splitContext: splitContext, nodeType: nodeType,
    compareRuns: compareRuns, errorPayloads: errorPayloads, itemLoss: itemLoss,
    brokenRefs: brokenRefs, allBrokenRefs: allBrokenRefs,
    MIN_PROFILE_RUNS: MIN_PROFILE_RUNS
  };
})(typeof window !== 'undefined' ? window : globalThis);
