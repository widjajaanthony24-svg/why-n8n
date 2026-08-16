# why? — watch this n8n

A workflow that watches your n8n and messages you when a run reports success
but didn't do anything useful.

The browser extension only looks when you open it, and it stops when Chrome
does — Manifest V3 service workers cannot outlive the browser, and a closed
laptop is off regardless. Your n8n, though, is already running around the
clock. So this runs *inside* it.

It uses the same detection engine as the extension, inlined from
`engine.js` by `build-watcher.js` — the two cannot disagree about what counts
as a failure.

## What it sends

```
why? found 2 runs worth looking at

• [output changed shape] Lead Enrichment #418  (vs 12 previous runs)
    summary shrank - was normally 144 chars, now 34 chars: "I'm sorry, I can't help with that."
• [produced nothing] Contact Extract #412  (seen 8x before)
    extraction was empty → Build CRM Record produced nothing

https://your-n8n/home/executions
```

Nothing else. If there is nothing to say, it says nothing.

## Setup — about five minutes

**1. Make an n8n API key.** Settings → **n8n API** → *Create an API key*.

If that entry isn't in your Settings menu, check **Settings → Personal** —
recent versions moved it, and it is a common enough confusion that there are
community threads about it. The key never leaves your instance: the workflow
calls your own n8n with it.

**2. Import `why-watch-n8n.json`.** Overview → Create Workflow → ⋯ → *Import
from File*.

**3. Edit the `Settings` node.** Two lines, and they are the only two things
you have to change:

```js
const n8nBaseUrl      = 'https://YOURNAME.app.n8n.cloud';   // no trailing slash
const alertWebhookUrl = 'https://hooks.slack.com/services/…';
```

A Slack incoming webhook or a Discord webhook both work — the message is sent
in a shape either will accept, so you don't have to tell it which.

**4. Give the two HTTP nodes your credential.** Open *List recent runs* and
*Fetch each run*, and pick your n8n API credential in each.

**5. Publish it.** It runs every 15 minutes from then on.

## First run is deliberately silent

The first poll records where it started and reports nothing, however many
broken runs are already sitting there. Announcing a week-old backlog as though
it just happened is how an alert channel gets muted on day one.

You will hear from it when something *new* happens.

## What it costs your instance

One API call per poll when nothing has happened — it fetches the execution
list, and only pulls full detail for runs it hasn't already judged. A busy
instance costs one call plus one per new run, capped at 15.

Its own executions are not saved (`saveDataSuccessExecution: none`), so it
doesn't fill up the log it's watching.

## What it learns

Shape drift needs to know what "normal" looks like, which takes at least 8
runs of a node. That memory lives in the workflow's own static data, so it
builds up over days and survives restarts. Nothing is stored anywhere else,
and no payload content ever leaves your instance.

## Limits worth knowing

- Needs an n8n API key. There is no way around that for a workflow reading
  executions.
- Watches the instance it runs in. For several instances, import it into each.
- Shape drift stays quiet for the first several runs of any node — by design.
- "Invented details" only applies to AI nodes. A Code node that mints an order
  reference is not making anything up, and asking where those digits came from
  would alert on nearly every healthy run.

## Rebuilding

After any change to `engine.js`:

```bash
node build-watcher.js
```

Then `node tests/run-all.js` — `watcher-test.js` runs the built workflow's own
code against a simulated n8n, so it tests the file you would actually import.
