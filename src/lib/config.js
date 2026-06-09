// Loads and validates configuration from environment variables at boot.
// In production (Replit) these come from Secrets. Locally they come from a
// .env file loaded via `node --env-file=.env` (Node 20+) or the platform.

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === null || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null ? fallback : value.trim();
}

function buildConfig() {
  const config = {
    split: {
      apiToken: required("SPLIT_API_TOKEN"),
      wsId: required("SPLIT_WS_ID"),
      envId: required("SPLIT_ENV_ID"),
      segmentName: optional("SPLIT_SEGMENT_NAME", "RUM100Perc_Workspaces"),
      approvers: required("SPLIT_APPROVERS")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      baseUrl: optional("SPLIT_BASE_URL", "https://api.split.io/internal/api/v2"),
    },
    clickup: {
      apiToken: required("CLICKUP_API_TOKEN"),
      // Defaults to ClickUp staging; set CLICKUP_BASE_URL to the prod API
      // (https://api.clickup.com/api/v2) when pointing at production.
      baseUrl: optional("CLICKUP_BASE_URL", "https://api.clickup-stg.com/api/v2"),
    },
    // Inbound auth for the ClickUp Automation "Call webhook" action. The
    // Automation sends a shared secret in a custom header (no HMAC signature),
    // which we compare in constant time.
    auth: {
      token: required("WEBHOOK_AUTH_TOKEN"),
      header: optional("WEBHOOK_AUTH_HEADER", "X-Auth-Token"),
    },
    workspaceIdField: optional("WORKSPACE_ID_FIELD", "Workspace ID [Perf]"),
    // Checkbox custom field that, when checked, re-runs the task (bypassing the
    // dedupe guard). The server unchecks it after processing.
    rerunField: optional("RERUN_FIELD", "Retry RUM"),
    // When the inline payload's workspace-ID field is empty (the Automation
    // snapshot raced ahead of the auto-populated value), wait and re-fetch the
    // task this many times, sleeping retryDelayMs between attempts.
    workspace: {
      retryDelayMs: Number(optional("WORKSPACE_RETRY_DELAY_MS", "3000")),
      maxRetries: Number(optional("WORKSPACE_MAX_RETRIES", "3")),
    },
    port: Number(optional("PORT", "3000")),
  };

  if (config.split.approvers.length === 0) {
    throw new Error("SPLIT_APPROVERS must contain at least one email.");
  }

  return config;
}

let cached = null;

// Lazily build + cache so importing this module doesn't throw before tests can
// set up their environment.
export function getConfig() {
  if (!cached) cached = buildConfig();
  return cached;
}

// Test helper to reset the cache between cases.
export function resetConfig() {
  cached = null;
}
