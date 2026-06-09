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
      webhookSecret: required("CLICKUP_WEBHOOK_SECRET"),
      // Defaults to ClickUp staging; set CLICKUP_BASE_URL to the prod API
      // (https://api.clickup.com/api/v2) when pointing at production.
      baseUrl: optional("CLICKUP_BASE_URL", "https://api.clickup-stg.com/api/v2"),
    },
    filter: {
      listId: optional("RUM_LIST_ID"),
      spaceId: optional("RUM_SPACE_ID"),
    },
    workspaceIdField: required("WORKSPACE_ID_FIELD"),
    port: Number(optional("PORT", "3000")),
  };

  if (!config.filter.listId && !config.filter.spaceId) {
    throw new Error(
      "Set at least one of RUM_LIST_ID or RUM_SPACE_ID to scope which tasks trigger the flow.",
    );
  }
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
