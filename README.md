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

1. Configure these variables — on Replit add them as **Secrets**; locally put
   them in a gitignored `.env`:
   - `SPLIT_API_TOKEN` — Harness FME (Split) Admin API key used to **create** the CR.
   - `SPLIT_APPROVE_TOKEN` — a **second** Admin API key used to **approve** the CR.
     FME blocks the creating key from approving, so this must be a *different* key
     that is registered as an approver on the environment (see below).
   - `SPLIT_WS_ID`, `SPLIT_ENV_ID`, `SPLIT_SEGMENT_NAME`, `SPLIT_APPROVERS`.
   - `CLICKUP_API_TOKEN` — to post the result comment.
   - `CLICKUP_BASE_URL` — defaults to staging; set to prod when needed.
   - `WEBHOOK_AUTH_TOKEN` — shared secret; must match the header the Automation sends.
   - `WORKSPACE_ID_FIELD` — workspace-ID custom field, by **field id** (preferred,
     stable across renames) or name.
   - `WORKSPACE_RETRY_DELAY_MS` / `WORKSPACE_MAX_RETRIES` — optional re-fetch
     tuning (defaults `3000` / `3`).
   - `RERUN_FIELD` — "Retry RUM" checkbox field, by **field id** (preferred) or
     name.

Custom fields are matched by ClickUp **field id** first, then name — prefer ids
since a field can be renamed without changing its id.
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

## Approval (two Admin API keys)

Harness FME does not allow the key that **submits** a change request to also
**approve** it. So the service uses two keys: `SPLIT_API_TOKEN` creates the CR and
`SPLIT_APPROVE_TOKEN` approves it. To make the approve key work:

1. Create a second Admin API key (distinct from `SPLIT_API_TOKEN`).
2. In the environment's **Require approval for changes** settings, choose
   **Restrict who can approve** and add that key as an approver. (Under *Let
   submitters choose their own approvers*, API approval isn't possible — a human
   must approve.)
3. Set it as `SPLIT_APPROVE_TOKEN`. If it's unset or equals `SPLIT_API_TOKEN`,
   the approve step returns 401 (and the server logs a warning at boot).

See [FME approval flows](https://developer.harness.io/docs/feature-management-experimentation/api/approvals/).

### Pending change request (423)

FME locks the **segment** while any change request on it is pending, so a new
create returns `423`. The server handles this instead of failing: it reads the
pending CR, posts a trail comment, and **approves** that pending CR.
- **Same workspace** as the task → that CR *is* this request, so approving it
  completes the task.
- **Different workspace** → approving it unblocks the queue; re-check **Retry
  RUM** on this task to process it once the lock clears.

## Re-running a failed request

To retry a task that failed (e.g. after fixing config) without creating a new
task, use a checkbox field + a second Automation:

- Add a checkbox custom field named **`Retry RUM`** (configurable via `RERUN_FIELD`).
- New Automation: **Trigger** = `Retry RUM` is set to *checked*; **Action** = Call
  webhook → the **same** URL `/` with the `X-Auth-Token` header.

When that fires, the server re-reads the live task and reprocesses it, **bypassing
the dedupe guard**, then **auto-unchecks** `Retry RUM` so it can be toggled again.
No payload is stored — the live ClickUp task is re-sent on demand.

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
