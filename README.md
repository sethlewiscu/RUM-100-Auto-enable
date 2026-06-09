# RUM Auto-Approve Server

Replaces the Zapier automation that requests and auto-approves "100% RUM" for
ClickUp workspaces. A ClickUp **Automation** ("Call webhook" action) posts to
this server, which adds the workspace key to the **`RUM100Perc_Workspaces`**
segment in Split.io (Harness) and approves the resulting change request.

## Flow

```
ClickUp Automation: Task created (3 source lists)
  + condition: "RUM Sampling Enabled?" is Unchecked
  + condition: "Workspace ID [Perf]" is set
  → "Call webhook" action → POST /
  → verify shared-secret header (X-Auth-Token)        (else 401)
  → parse Automation payload; read task from `payload`
  → read workspace key from payload.custom_fields ("Workspace ID [Perf]")
        if empty (snapshot raced ahead of the auto-populated value):
        wait + GET /task/{id} and re-read, up to WORKSPACE_MAX_RETRIES times
  → POST Split "Add Key" change request                 → CR id
  → PUT  Split "Approve CR" with that id                → APPROVED
  → POST result comment back on the ClickUp task
```

The Automation payload embeds the full task inline, so the happy path needs no
ClickUp API call. The field can be auto-populated a beat after the snapshot is
taken, so when the inline workspace ID is empty the server re-fetches the task
(`GET /task/{id}`) a few times — tunable via `WORKSPACE_RETRY_DELAY_MS`
(default 3000) and `WORKSPACE_MAX_RETRIES` (default 3).

## Endpoints

- `GET /health` — liveness check.
- `POST /` — ClickUp Automation "Call webhook" receiver.

## Setup

1. Copy `.env.example` and fill in values (on Replit, add them as **Secrets**):
   - `SPLIT_API_TOKEN` — **rotate** the token that leaked in the Postman file.
   - `SPLIT_WS_ID`, `SPLIT_ENV_ID`, `SPLIT_SEGMENT_NAME`, `SPLIT_APPROVERS`.
   - `CLICKUP_API_TOKEN` — to post the result comment.
   - `CLICKUP_BASE_URL` — defaults to staging; set to prod when needed.
   - `WEBHOOK_AUTH_TOKEN` — shared secret; must match the header the Automation sends.
   - `WORKSPACE_ID_FIELD` — defaults to `Workspace ID [Perf]`.
2. `npm install`
3. Run:
   - Local: `node --env-file=.env src/index.js`
   - Replit: `npm start` (Secrets are injected automatically).

## ClickUp Automation

In the source space, create an Automation:
- **Trigger:** Task created (select the source lists).
- **Conditions:** `RUM Sampling Enabled?` is Unchecked **and** `Workspace ID [Perf]` is set.
- **Action:** Call webhook → URL `https://<your-replit-url>/` and add a custom
  **header** `X-Auth-Token: <WEBHOOK_AUTH_TOKEN>` (same value as the secret).

The server rejects any request whose `X-Auth-Token` header doesn't match.

## Tests

```
npm test
```

Covers token auth (accept/reject), the Split CR-id extractor, workspace-key
extraction from the Automation payload, and an in-process integration test of the
full handler with mocked ClickUp + Split calls.

## Items to confirm during the first live run

- Exact **CR id field name** in the Split "Add Key" response — `src/lib/split.js`
  `extractChangeRequestId()` checks the likely shapes; adjust if needed.
- Split's self-approval rule: the approving token must belong to a different
  Split user than the `approvers`, or the approve call may 403. The error is
  surfaced in logs and the ClickUp comment.
