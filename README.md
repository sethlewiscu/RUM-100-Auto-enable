# RUM Auto-Approve Server

A small Node.js webhook server that replaces the Zapier automation for auto-approving "100% RUM" in ClickUp workspaces. When a ClickUp Automation triggers (new task in the source lists), this server adds the workspace key to the Split.io (Harness FME) segment and approves the change request, then posts the result as a comment on the task.

**Production host:** Replit — environment variables are configured there as Secrets and the server starts automatically with `npm start`.

---

## Quick Start (local)

```bash
git clone <repo-url>
cd rum-zap-migration
npm install
cp .env.example .env   # fill in your secrets (see below)
npm run dev            # loads .env, LOG_LEVEL=debug, watches for changes
```

Run tests:

```bash
npm test
```

---

## Environment Variables

Add these as `.env` locally or as **Secrets** on Replit.

| Variable | Required | Description |
|---|---|---|
| `SPLIT_API_TOKEN` | Yes | Harness FME Admin API key — **creates** the change request |
| `SPLIT_APPROVE_TOKEN` | Yes | A **second** Admin API key — **approves** the CR (must be different from above; see [Split Setup](#split--harness-setup)) |
| `SPLIT_WS_ID` | Yes | Split workspace ID |
| `SPLIT_ENV_ID` | Yes | Split environment ID |
| `SPLIT_SEGMENT_NAME` | Yes | The segment to add workspace keys to |
| `SPLIT_APPROVERS` | Yes | Comma-separated list of approver identifiers for the CR |
| `CLICKUP_API_TOKEN` | Yes | ClickUp API token — posts result comments on tasks |
| `CLICKUP_BASE_URL` | Yes | ClickUp API base URL (defaults to staging; set to prod when needed) |
| `WEBHOOK_AUTH_TOKEN` | Yes | Shared secret — must match the `X-Auth-Token` header the Automation sends |
| `WORKSPACE_ID_FIELD` | Yes | The ClickUp custom field that holds the workspace ID — use the **field id** (stable across renames) or field name |
| `APPROVED_FIELD` | Yes | The "RUM approved" checkbox custom field — by field id or name |
| `RERUN_FIELD` | No | The "Retry RUM" checkbox custom field — enables manual re-runs (field id or name) |
| `WORKSPACE_RETRY_DELAY_MS` | No | How long to wait between retries when workspace ID is missing (default: `3000`) |
| `WORKSPACE_MAX_RETRIES` | No | Max re-fetch attempts for a missing workspace ID (default: `3`) |
| `LOG_LEVEL` | No | `debug\|info\|warn\|error` (default: `info`; `npm run dev` sets `debug`) |

> **Field IDs vs. names:** Custom fields are matched by id first, then name. Use the field id where possible — it won't break if the field is renamed.

---

## ClickUp Automation Setup

In the source space, create an Automation:

- **Trigger:** Task created — select the source lists
- **Conditions:**
  - `RUM Sampling Enabled?` is **Unchecked**
  - `Workspace ID [Perf]` is **set**
- **Action:** Call webhook
  - URL: `https://<your-replit-url>/`
  - Header: `X-Auth-Token: <WEBHOOK_AUTH_TOKEN>`

The server rejects requests whose `X-Auth-Token` doesn't match `WEBHOOK_AUTH_TOKEN`.

---

## Split / Harness Setup

Harness FME doesn't allow the same API key to both **submit** and **approve** a change request. This server uses two keys:

1. `SPLIT_API_TOKEN` — submits the CR
2. `SPLIT_APPROVE_TOKEN` — approves it (must be a different key)

To configure the approve key:
1. Create a second Admin API key in Harness FME.
2. In the environment's **Require approval for changes** settings, choose **Restrict who can approve** and add that key as an approver.
3. Set it as `SPLIT_APPROVE_TOKEN`.

If `SPLIT_APPROVE_TOKEN` is unset or matches `SPLIT_API_TOKEN`, the approve step will return 401 and the server logs a warning at boot.

---

## Local Debugging with ngrok

To intercept live ClickUp Automation traffic in your terminal — with the real payload and full stack traces:

1. **Install + auth ngrok** (one-time): `brew install ngrok`, then `ngrok config add-authtoken <token>`
2. **Run the server:** `npm run dev`
3. **Start the tunnel:** `ngrok http 3000` — copy the `https://<id>.ngrok-free.app` URL
4. **Repoint the Automation** in the ClickUp UI: change the webhook URL to your ngrok URL (keep the `X-Auth-Token` header)
5. Trigger a real RUM request and watch the logs in your terminal
6. **Restore the Automation URL to Replit when done**

ngrok's local inspector at `http://127.0.0.1:4040` shows each raw delivery.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 401 on approve step | `SPLIT_APPROVE_TOKEN` is wrong, stale, or not registered as an approver | Verify the key in Harness FME approver settings; check Replit Secrets |
| 423 Locked segment | Another change request on this segment is pending | Server handles this automatically by approving the pending CR; if the workspace differs, check **Retry RUM** once it clears |
| `OAUTH_194 "Specified URL not allowed"` | ClickUp can't reach localhost | Use the ngrok **HTTPS** URL, not `http://localhost` |
| "no task in payload" | Wrong webhook type | Must be a ClickUp **Automation** "Call webhook" — not an API webhook (`/api/v2/webhook`) |
| Workspace ID always empty | Field not found | Check `WORKSPACE_ID_FIELD` — use the field id, not a display name that may have changed |
| Succeeds locally, fails on Replit | Stale Replit Secret | Update `SPLIT_APPROVE_TOKEN` (or whichever var differs) in Replit Secrets and restart |

---

## Re-running a Failed Task

To retry without creating a new task:

1. Add a **`Retry RUM`** checkbox custom field to the task (configurable via `RERUN_FIELD`).
2. Create a second Automation: **Trigger** = `Retry RUM` checked → **Action** = Call webhook to the same URL with the same `X-Auth-Token` header.

Checking **Retry RUM** on a task re-sends it to the server, which reprocesses it and auto-unchecks the field so it can be used again.

---

## Contributing

1. Branch from `main` (or fork the repo)
2. Make your changes and run `npm test` to confirm nothing is broken
3. Open a pull request against `main` with a short description of what changed and why
