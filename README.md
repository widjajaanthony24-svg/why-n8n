# why? for n8n

**Finds the n8n runs that reported success and didn't actually do anything —
and, while you're building, tells you what your last change did to the output.**

A browser extension. No account, no API key, no SDK, no self-hosting. It reads
the n8n you're already signed into.

## ⬇️  Download

### **[Get the latest release →](https://github.com/widjajaanthony24-svg/why-n8n/releases/latest)**

Then: **unzip it** → open `chrome://extensions` → turn on **Developer mode**
(top right) → **Load unpacked** → pick the unzipped folder.

Open n8n, go to **Executions**, click the toolbar icon. That's it — nothing to
sign up for and nothing to configure.

> Chrome Web Store listing is in review. Until it's approved, the release zip
> above is the way in. Works on Chrome, Edge, Brave, Arc, Opera and Vivaldi.

*Everything below is what it does and how it works. You don't need to read it to
use it.*

---

## The problem

n8n tells you when a workflow crashes. It says nothing when a workflow quietly
stops working.

A step returns nothing. An expression points at a field that got renamed last
month. An API replies `200 OK` with an error buried in the body. Every step
after that silently doesn't happen — and the run still shows up green, marked
**Succeeded**.

You find out three days later, when a client asks why they stopped getting
leads.

## What it catches

```
#412  Lead Router        Enrich Lead · url uses $json.customer.email
                         there is no "customer" in its input — it resolved to
                         nothing and the run carried on

#418  Contact Extract    extraction was empty → Build CRM Record produced nothing
                         first seen 3d ago   9/9 runs

#421  Lead Enrichment    Build CRM Record · confidence type — was number, now string "high"
                         summary shrank — was normally 144 chars, now 34:
                         "I'm sorry, I can't help with that."
```

Every one of those runs is marked successful in n8n.

Most of these need no AI node at all:

| | |
|---|---|
| **A field that wasn't there** | `{{ $json.customer.email }}` where the input has no `customer`. Resolves to nothing, node runs, field goes out blank, run is green. Probably the most common silent failure in n8n, and nothing else surfaces it. |
| **An error inside a `200`** | the HTTP node is happy — it got a reply — and the body says `rate limit exceeded`. Expired tokens, throttling and validation failures all arrive this way. |
| **Items lost mid-run** | 50 rows in, 47 out. Three records dropped and nobody noticed. |
| **Produced nothing** | a node emitted zero items — and which exact upstream field was empty, including keys buried inside JSON-in-a-string. |
| **Output changed shape** | a score that was a number and is now the text `"high"`; a summary that ran 140 characters and now runs 30. |
| **Sub-workflows** | when the fault is inside a child workflow it says so, and drills in, instead of blaming the parent. |
| **Correlated failures** | several workflows breaking together, so you look for one shared cause. |
| **How long** | how long a fault has been happening, across scans and across sessions. |

For workflows with AI nodes it also separates the three cases that need
different fixes:

| It says | It means |
|---|---|
| **bad context** | a tool errored, returned nothing, or came back about a different record — and it answered anyway |
| **wrong decision** | the answer contradicts the data it was given (`tier = mid-market, but its source says enterprise`) |
| **hallucinated** | the answer contains details that appear in nothing it was handed |

Root cause beats symptom: if retrieval missed *and* the answer invented
something, it reports bad context — sending you to fix the prompt when the bug
is in the vector store wastes your afternoon.

## While you're building

Open it on a workflow, press **Compare each run ▸**, and leave it open. Every
time you hit Execute:

```
run #418  vs  #417
3 changes in Build CRM Record
  tier         changed   "enterprise"  →  "mid-market"
  confidence   type      number  →  string "high"
  summary      shorter   144 chars  →  34 chars: "I'm sorry, I can't help…"
```

Or, just as usefully: **`Output identical to the previous run.`** — your change
did nothing.

n8n keeps no memory of your last run, so that comparison normally happens in
your head. Works from a workflow's second execution; no history or AI node
needed.

---

## Install

**From source** (works today):

1. Download the latest release, or clone this repository
2. Open `chrome://extensions` and turn on **Developer mode**
3. **Load unpacked** → select the folder
4. Open n8n → **Executions** → click the toolbar icon

Works unchanged on **Chrome, Edge, Brave, Arc, Opera and Vivaldi** — every API
it uses is standard Manifest V3. Firefox needs a small compatibility shim (not
done yet). Safari would need an Xcode conversion.

---

## It tries hard not to cry wolf

A tool that flags healthy runs gets uninstalled on day two, so most of the work
here is in the cases where it stays quiet:

- a Filter, Remove Duplicates or Limit node that legitimately kept nothing
- an IF or Switch where the branch wasn't taken
- a trigger with nothing to hand on
- an expression whose author already handled the field being missing — `||`,
  `??`, `?.`, a ternary, an `if()`
- a reference that resolves on *any* item, since optional fields are normal
- a Code node in its default mode turning 50 items into one summary row
- a Code node minting an order reference — that isn't hallucinating
- long prose reworded at a similar length between runs
- fields that were always varied
- any node with fewer than 8 runs of history — it refuses to judge thin evidence

Frequency is shown, never used to hide anything. A workflow broken for two days
looks identical to a poll that usually finds nothing; only the node *type* can
tell those apart, so type decides what gets demoted.

## If it gets something wrong

Every finding has an **✕**. One click and that node in that workflow is never
mentioned again — and the ignore list is one click to clear if you change your
mind.

There's also a **certain only** toggle. Some findings are facts about the run: a
node emitted nothing, an API said no, an expression pointed at a field that
wasn't there. Others are inferred from history: this output doesn't look like it
usually does. The inferences are where the value is *and* where crying wolf
would come from — so one click hides them and leaves only what's verifiable.

## It gets better the longer it's installed

Shape checks need a node's own history, so a workflow you built this morning
normally gets nothing. But what an OpenAI node emits doesn't change between your
workflows — so it learns per **node type** across your whole instance, and a
brand-new workflow is judged from its first run:

> *this workflow is too new to know itself — compared against 14 runs of `agent`
> elsewhere on this instance*

Pooled baselines never punish a workflow for being shaped differently: a field
the baseline expects but this workflow doesn't use is ignored, not reported.

## Watching while you're not looking

The **watch** toggle checks in the background and puts a count on the toolbar
icon. But that stops when the browser does — Manifest V3 service workers can't
outlive it, and a closed laptop is off regardless.

Your n8n can. [`watcher/`](watcher/) is a workflow you import into your own
instance: same engine, every 15 minutes, messages Slack or Discord. No server,
no account, and no key handed to anyone — it calls your own n8n with your own
key. Needs API access, so self-hosted or a paid n8n Cloud plan.

---

## Honest limits

- Chromium browsers only for now; Firefox needs a shim
- Reads the most recent 40 executions per scan by default — *"look back
  further"* at the bottom of a scan goes to 100 or 250, at the cost of more
  requests to your n8n
- Shape checks need 8+ prior runs of a node, or a learned baseline for its type
- The three-way AI diagnosis and invented-detail checks only apply to nodes with
  a model attached
- It can spot an answer that contradicts its own source. It **cannot** tell you
  an answer is wrong when the data was right — that needs to know the correct
  answer, and nothing does
- The watcher needs n8n API access, which n8n Cloud excludes from its free trial

## Privacy

No server. No analytics. No account. Nothing is ever transmitted anywhere.

Execution data is read into memory, analysed, and discarded. What's stored
locally is your settings, your ignore list, a record of which faults were seen
and when, and statistics describing what your nodes' output normally looks like.
It's deleted when you uninstall. Full detail in [PRIVACY.md](PRIVACY.md).

## Security

Workflow definitions are treated as untrusted input, because n8n templates are
shared and imported freely:

- the replay URL is resolved and verified to stay under `/webhook/`, so a
  hostile template can't turn the replay button into a request against your n8n
  API
- every map keyed by payload fields is null-prototype — a field named
  `__proto__` would otherwise corrupt every object on the page
- payload recursion depth, payload width, and ids are all bounded and validated

Found something? Open an issue. For security issues, please report privately
first.

## Tests

No dependencies, no build step.

```bash
node tests/run-all.js
```

201 checks across 17 suites. Most are negatives — the cases where it must stay
quiet — because that's what decides whether a tool survives its first week.
Among them: a smoke test that loads the real files in a stub browser and checks
the rendered panel, because the unit tests extract functions into a fresh scope
and structurally cannot catch a whole-file bug.

After changing `engine.js`, rebuild the watcher so the two can't drift apart:

```bash
node build-watcher.js
```

To produce a Chrome Web Store package (source only, no test code):

```bash
node build-package.js
```

## Status

New, and honest about it. It has been run against real n8n Cloud and
self-hosted instances, but the heuristics have not yet met a large number of
other people's workflows. If it flags something healthy on yours, that's a bug
worth reporting — those reports are the most useful thing anyone can send.

## Licence

MIT.
