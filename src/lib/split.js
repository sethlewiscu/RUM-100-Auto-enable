import { getConfig } from "./config.js";
import { log, tokenType } from "./logger.js";

// Wrapper around the two Split.io (Harness) Segment change-request endpoints
// from the Postman collection:
//   1. createSegmentKeyCR  -> "Segment - Add Key API"
//   2. approveCR           -> "Segment - Approve Segment CR"

// Response headers worth capturing on failure — FME's transactionId is the key
// 401 discriminator (a 401 *with* one means the token is accepted but isn't a
// registered approver; *without* one means the credential itself was rejected).
const INTERESTING_HEADERS = ["transactionid", "x-request-id", "www-authenticate"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a Split API operation with exponential backoff. On failure, retries up to
// maxRetries times with delays (0ms, then initialDelayMs * 1, * 2, etc.).
// Returns { success: true, result } or { success: false, lastError, attempts }.
// shouldRetry(err) is optional: if returns false, the error is re-thrown immediately.
async function withRetry(fn, label, { maxRetries = 3, initialDelayMs, shouldRetry = () => true } = {}) {
  // Allow override via env for tests; default to 30 seconds in production
  if (initialDelayMs === undefined) {
    initialDelayMs = Number(process.env.SPLIT_RETRY_DELAY_MS ?? 30000);
  }
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) log.info(`[split] ${label} succeeded on attempt ${attempt}`);
      return { success: true, result };
    } catch (err) {
      lastError = err;
      // If shouldRetry returns false, don't retry — throw immediately
      if (!shouldRetry(err)) {
        throw err;
      }
      if (attempt > maxRetries) {
        return { success: false, lastError, attempts: attempt };
      }
      const delay = initialDelayMs * (attempt - 1);
      log.warn(`[split] ${label} attempt ${attempt} failed; retrying in ${delay}ms`, {
        err: err.message,
      });
      if (delay > 0) await sleep(delay);
    }
  }
}

async function splitFetch(path, options = {}, token) {
  const { split } = getConfig();
  const method = options.method || "GET";
  const effectiveToken = token || split.apiToken;

  // Pre-flight (debug): which token *type* actually went out, so we can confirm
  // the approve PUT used the approve token — never logs the secret.
  log.debug(`Split ${method} ${path}`, {
    url: `${split.baseUrl}${path}`,
    auth: `Bearer ${tokenType(effectiveToken)}`,
    bodyKeys: options.body ? Object.keys(JSON.parse(options.body)) : [],
  });

  const res = await fetch(`${split.baseUrl}${path}`, {
    ...options,
    headers: {
      // Matches the working Zapier structure: sat. create token and pat. approve
      // token are both sent as Authorization: Bearer.
      Authorization: `Bearer ${effectiveToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Split ${method} ${path} failed: ${res.status} ${text}`);
    err.status = res.status;
    err.method = method;
    err.path = path;
    err.headers = {};
    for (const name of INTERESTING_HEADERS) {
      const value = res.headers?.get?.(name);
      if (value) err.headers[name] = value;
    }
    try {
      err.body = text ? JSON.parse(text) : null;
    } catch {
      err.body = null;
    }
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// Fetch a single change request (includes segment.keys and status).
export function getChangeRequest(crId) {
  return splitFetch(`/changeRequests/${encodeURIComponent(crId)}`);
}

// Pull the pending change request id out of a 423 error body. The FME message is
// e.g. "A pending change request with id:7f69afb0-… for this object already exists".
export function parsePendingCrId(errBody) {
  const details = errBody && typeof errBody === "object" ? errBody.details : "";
  const m = /id:\s*([0-9a-f-]+)/i.exec(String(details || ""));
  return m ? m[1] : null;
}

// The workspace key(s) carried by a change request's segment change.
export function extractCrKeys(cr) {
  const keys = cr?.segment?.keys;
  return Array.isArray(keys) ? keys.map((k) => String(k).trim()).filter(Boolean) : [];
}

// Creates a change request that adds the given workspace keys to the RUM
// segment. Returns the parsed change request, from which we pull the id.
export async function createSegmentKeyCR(keys, { title, comment }) {
  const { split } = getConfig();
  const body = {
    segment: { name: split.segmentName, keys },
    operationType: "CREATE",
    title,
    comment,
    approvers: split.approvers,
  };

  const result = await splitFetch(
    `/changeRequests/ws/${split.wsId}/environments/${split.envId}`,
    { method: "POST", body: JSON.stringify(body) },
  );

  const crId = extractChangeRequestId(result);
  if (!crId) {
    throw new Error(
      `Could not find change request id in Split response: ${JSON.stringify(result)}`,
    );
  }
  return { crId, raw: result };
}

// Harness FME requires a *different* Admin API key (registered as an approver on
// the environment) to approve a change request than the one that created it.
export function approveCR(crId, comment = "CR approved via Admin API") {
  const { split } = getConfig();
  return splitFetch(
    `/changeRequests/${encodeURIComponent(crId)}`,
    { method: "PUT", body: JSON.stringify({ status: "APPROVED", comment }) },
    split.approveToken || split.apiToken,
  );
}

// The exact location of the id in the Add-Key response should be confirmed
// during the live dry-run (see plan Verification step 3). We check the most
// likely shapes so this is robust to either form.
export function extractChangeRequestId(response) {
  if (!response || typeof response !== "object") return null;
  return (
    response.id ||
    response.changeRequestId ||
    response.changeRequest?.id ||
    response.cr?.id ||
    null
  );
}

// Check which of `keys` are already members of the RUM segment in this
// environment. Paginates the segment-keys endpoint and early-exits once every
// target key is found. Returns { present, missing } (string-compared).
export async function getSegmentKeyMembership(keys) {
  const { split } = getConfig();
  const target = new Set(keys.map((k) => String(k)));
  const present = new Set();
  const segPath = `/segments/${encodeURIComponent(split.envId)}/${encodeURIComponent(split.segmentName)}/keys`;

  const limit = 100;
  let offset = 0;
  let total = Infinity;
  while (offset < total && present.size < target.size) {
    const page = await splitFetch(`${segPath}?limit=${limit}&offset=${offset}`);
    total = Number.isFinite(page?.count) ? page.count : 0;
    const pageKeys = Array.isArray(page?.keys) ? page.keys : [];
    for (const entry of pageKeys) {
      const k = String(entry?.key ?? entry);
      if (target.has(k)) present.add(k);
    }
    if (pageKeys.length === 0) break; // no more data, avoid infinite loop
    offset += pageKeys.length;
  }

  return {
    present: [...present],
    missing: [...target].filter((k) => !present.has(k)),
  };
}

// Retry-enabled wrapper exports for the three Split operations that may be transient.
// These wrappers use exponential backoff (0ms, 30s, 60s delays) and return
// { success, result | lastError, attempts } instead of throwing.

export async function createSegmentKeyCRWithRetry(keys, meta) {
  // Don't retry 423 (segment locked) — let it bubble up to the 423 handler.
  // Retry other transient errors (5xx, timeouts, etc.).
  return withRetry(
    () => createSegmentKeyCR(keys, meta),
    "create segment CR",
    {
      shouldRetry: (err) => err.status !== 423, // skip retry for 423
    },
  );
}

export async function approveCRWithRetry(crId, comment) {
  return withRetry(
    () => approveCR(crId, comment),
    "approve CR",
  );
}

export async function getSegmentKeyMembershipWithRetry(keys) {
  return withRetry(
    () => getSegmentKeyMembership(keys),
    "check segment membership",
  );
}
