# RUM Auto-Approve Server

Replaces the Zapier automation that requests and auto-approves "100% RUM" for
ClickUp workspaces. A ClickUp `taskCreated` webhook hits this server, which adds
the workspace key to the **`RUM100Perc_Workspaces`** segment in Split.io
(Harness) and approves the resulting change request.

## Flow

```
ClickUp taskCreated webhook
  → POST /webhooks/clickup
  → verify X-Signature (HMAC-SHA256 of raw body w/ webhook secret)
  → GET ClickUp task by task_id
  → filter: only tasks in RUM_LIST_ID / RUM_SPACE_ID    (else 200 + ignore)
  → read workspace ID from the WORKSPACE_ID_FIELD custom field
  → POST Split "Add Key" change request                 → CR id
  → PUT  Split "Approve CR" with that id                → APPROVED
  → POST result comment back on the ClickUp task
```

## Endpoints

- `GET /health` — liveness check.
- `POST /webhooks/clickup` — ClickUp webhook receiver.

## Setup

1. Copy `.env.example` and fill in values (on Replit, add them as **Secrets**):
   - `SPLIT_API_TOKEN` — **rotate** the token that leaked in the Postman file.
   - `SPLIT_WS_ID`, `SPLIT_ENV_ID`, `SPLIT_SEGMENT_NAME`, `SPLIT_APPROVERS`.
   - `CLICKUP_API_TOKEN`, `CLICKUP_WEBHOOK_SECRET`.
   - `RUM_LIST_ID` and/or `RUM_SPACE_ID` (at least one).
   - `WORKSPACE_ID_FIELD` — the custom field id or name holding the workspace ID.
2. `npm install`
3. Run:
   - Local: `node --env-file=.env src/index.js`
   - Replit: `npm start` (Secrets are injected automatically).

## ClickUp webhook

Create the webhook (Postman or the ClickUp API) pointing at
`https://<your-replit-url>/webhooks/clickup`, subscribed to `taskCreated`, with
the same secret you put in `CLICKUP_WEBHOOK_SECRET`. ClickUp signs each delivery
with `X-Signature` (HMAC-SHA256 over the raw body); this server rejects requests
that don't match.

## Tests

```
npm test
```

Covers signature verification, the Split CR-id extractor, and the ClickUp
list-filter / custom-field parsing using shapes from `task-payload-example.json`.

## Items to confirm during the first live run

- Exact **CR id field name** in the Split "Add Key" response — `src/lib/split.js`
  `extractChangeRequestId()` checks the likely shapes; adjust if needed.
- The **custom field** id/name and the **list/space** id.
- Split's self-approval rule: the approving token must belong to a different
  Split user than the `approvers`, or the approve call may 403. The error is
  surfaced in logs and the ClickUp comment.
```
