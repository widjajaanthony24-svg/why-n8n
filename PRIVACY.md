# Privacy Policy — why? for n8n

_Last updated: 16 August 2026_

## The short version

This extension does not collect, transmit, sell, or share any data. There is no
server, no analytics, no account, and no tracking of any kind. Everything it
does happens inside your own browser.

## What it reads

When you click the toolbar icon — or when you switch on the optional automatic
checks — the extension reads workflow execution data from the n8n instance you
are already signed into. It does this the same way the n8n page itself does,
using your existing session, over a same-origin request to that n8n and nothing
else.

That execution data is held in memory only, for as long as it takes to analyse
it, and is then discarded. **It is never sent anywhere.**

## What it stores on your device

The following is saved in your browser's local extension storage
(`chrome.storage.local`). It never leaves your machine and is deleted when you
uninstall the extension:

- **Your settings** — which n8n sites you switched automatic checking on for,
  and where you dragged the panel.
- **Your ignore list** — the workflow-and-node combinations you told it to stop
  mentioning.
- **A record of what it found** — the identifier of each fault and the
  timestamps it was seen, so it can tell you how long something has been
  happening. This holds no payload content.
- **Learned output shapes** — statistics describing what a node's output
  normally looks like: field names, value types, typical text lengths. Field
  *values* are only retained for fields with a small, fixed set of possible
  values, because that is what makes it possible to notice an unexpected one.
- **A browser identifier** that n8n itself sets, which the background check
  needs in order to authenticate with your n8n in the same way the page does.

## What it never does

- It never sends your execution data, payloads, credentials, or workflows to
  any server, including ours. There is no "ours" — no backend exists.
- It never collects personally identifiable information, health, financial,
  authentication, location, or browsing-history data.
- It never uses or transfers data for advertising, creditworthiness, or lending.
- It never sells or shares data with third parties.
- It has no analytics or telemetry. We have no way of knowing you installed it.

## Permissions, and why each exists

- **activeTab** — reads the n8n page you explicitly clicked the icon on.
- **scripting** — puts the analysis panel onto that page.
- **storage** — saves the local settings described above.
- **alarms** — runs the optional background check on a timer, only if you turn
  it on.
- **Host access to n8n addresses** — so the optional background check can reach
  your n8n without you clicking. n8n is often self-hosted on a domain that
  cannot be known in advance, so broader access is declared as *optional* and is
  **never requested at install**. It is requested at the moment you switch on
  background checking for one specific site, and applies only to that site.

## Optional outbound requests you trigger yourself

Two features send a request, and only when you click them:

- **Replay** re-sends a stored payload to a webhook on **your own n8n**. The
  destination is verified to be a `/webhook/` address on that same n8n before
  anything is sent.
- The separate, optional **watcher workflow** (not part of this extension) runs
  inside your own n8n and posts to a Slack or Discord address that you supply.

## Source code

The extension is open source under the MIT licence. You can read exactly what it
does before installing it.

## Contact

Please open an issue on the GitHub repository.
