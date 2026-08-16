# Shape of an n8n execution JSON

Source: `GET /api/v1/executions/{id}?includeData=true` — n8n **2.34.6**, community edition.
Without `?includeData=true` you get only the top-level scalars; `data` is omitted entirely.

## Top level

| Field | Notes |
|---|---|
| `id` | **string**, not a number (`"1"`) |
| `status` | `"success"` \| `"error"` — the only two seen here |
| `finished` | `true` on success, `false` on error |
| `mode` | `"webhook"` here; `"manual"`, `"trigger"` etc. elsewhere |
| `createdAt` / `startedAt` / `stoppedAt` | ISO-8601 strings |
| `workflowId` | e.g. `"ZRnQbcm647EiRA4Z"` |
| `data` | everything below |
| `workflowData` | full snapshot of the workflow definition at run time (`.nodes`, `.connections`, `.name`) |

## Where node data lives

```
data.resultData.runData          <- object KEYED BY NODE DISPLAY NAME
data.resultData.lastNodeExecuted <- string, name of final node reached
data.resultData.error            <- present only when status === "error"
```

`runData["Some Node"]` is an **array** — one entry per *run* of that node (loops/retries add entries). Single-pass runs are always index `[0]`.

Each node-run entry:

```
startTime        epoch milliseconds (number)  <- NOT ISO, unlike the top level
executionIndex   0,1,2... order the node ran
executionTime    milliseconds
executionStatus  "success" | "error"
source           [{ previousNode, previousNodeOutput, previousNodeRun }]
data.main[outputIndex][itemIndex].json   <- the node's OUTPUT payload
error            present INSTEAD OF data when the node failed
```

## Things that surprised me

1. **Node inputs are not stored.** Only outputs (`data.main`). To get a node's input you must look up `source[0].previousNode` and read *that* node's output. There is no `input` key anywhere.
2. **A failed node has no `data` key at all** — it has `error` instead. Code that does `runData[n][0].data.main[0]` will throw on error fixtures.
3. **`status: "success"` does not mean every node ran.** In `silent_fail_2.json`, `Parse AI Output` returned zero items, so `Send Result` never executed and is **absent from `runData`** — yet the run is `success` with `finished: true`. Node absence, not node failure, is the signal.
4. Errors appear in **two places**: `data.resultData.error` (with `.node.name` naming the culprit) and on the node-run itself. `httpCode` carries `ENOTFOUND` (dead host) vs `ECONNABORTED` (timeout).
5. Timestamps are mixed formats: ISO strings at top level, epoch ms inside `runData`.
6. `pairedItem` rides along on every output item, tracking lineage back to the input item.

## Trimmed example (from `baseline.json`)

```json
{
  "id": "1",
  "finished": true,
  "status": "success",
  "mode": "webhook",
  "startedAt": "2026-08-14T13:08:41.986Z",
  "stoppedAt": "2026-08-14T13:08:43.823Z",
  "workflowId": "ZRnQbcm647EiRA4Z",
  "data": {
    "resultData": {
      "lastNodeExecuted": "Send Result",
      "runData": {
        "Simulate AI Response": [
          {
            "startTime": 1786712923070,
            "executionIndex": 2,
            "executionTime": 362,
            "executionStatus": "success",
            "source": [{ "previousNode": "Fetch Source Data" }],
            "data": {
              "main": [[
                {
                  "json": { "scenario": "baseline", "aiText": "{\"items\":[...]}" },
                  "pairedItem": { "item": 0 }
                }
              ]]
            }
          }
        ]
      }
    }
  }
}
```

## The five fixtures

| File | n8n exec | `status` | What happened |
|---|---|---|---|
| `baseline.json` | 1 | success | all 5 nodes green, real output |
| `silent_fail_1.json` | 2 | success | `Parse AI Output` emitted `{"json":{}}`; every node green |
| `silent_fail_2.json` | 3 | success | `Parse AI Output` emitted 0 items; `Send Result` never ran |
| `hard_error.json` | 4 | error | `ENOTFOUND` on a dead domain |
| `timeout.json` | 5 | error | `ECONNABORTED` after the node's 8 s limit |
