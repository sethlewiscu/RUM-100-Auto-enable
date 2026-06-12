// Loads and validates configuration from environment variables at boot.
// In production (Replit) these come from Secrets. Locally they come from a
// .env file loaded via `node --env-file=.env` (Node 20+) or the platform.

import { log } from "./logger.js";

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

// Tokens are sent as "Authorization: Bearer <token>", so strip a stray leading
// "Bearer " (case-insensitive) and surrounding whitespace from a pasted value to
// avoid a doubled "Bearer Bearer ...".
function cleanToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function buildConfig() {
  const config = {
    split: {
      apiToken: cleanToken(required("SPLIT_API_TOKEN")),
      // Harness FME blocks the key that creates a change request from approving
      // it — approval must use a different Admin API key that is registered as an
      // approver on the environment. Used only for the approve PUT.
      approveToken: cleanToken(optional("SPLIT_APPROVE_TOKEN", "")),
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
    // Custom field holding the workspace ID. Matched by ClickUp field id
    // (preferred — stable across renames) or, as a fallback, by name.
    workspaceIdField: optional("WORKSPACE_ID_FIELD", "3ab9bbf1-0dca-4e55-b56e-c04c1f7cf2ac"),
    // Checkbox custom field that, when checked, re-runs the task (bypassing the
    // dedupe guard). The server unchecks it after processing. Identified by
    // ClickUp field id (preferred) or name.
    rerunField: optional("RERUN_FIELD", "4c9e4cde-23e4-4a18-bef3-fa8f52a29f01"),
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
  if (!config.split.approveToken || config.split.approveToken === config.split.apiToken) {
    log.warn(
      "[config] SPLIT_APPROVE_TOKEN is unset or equal to SPLIT_API_TOKEN — change-request approval will 401. Set a distinct Admin API key registered as an approver.",
    );
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
