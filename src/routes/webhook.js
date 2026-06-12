import express from "express";
import { isValidToken } from "../lib/verifyToken.js";
import { getConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import {
  addComment,
  extractWorkspaceKeys,
  getTask,
  getCheckboxField,
  setCustomField,
} from "../lib/clickup.js";
import {
  createSegmentKeyCR,
  approveCR,
  getChangeRequest,
  parsePendingCrId,
  extractCrKeys,
} from "../lib/split.js";

export const router = express.Router();

// Short-lived in-memory dedupe so retried deliveries don't create duplicate
// change requests for the same task.
const recentlyProcessed = new Map(); // task id -> timestamp(ms)
const DEDUPE_TTL_MS = 5 * 60 * 1000;

function alreadyProcessed(taskId, now) {
  const seen = recentlyProcessed.get(taskId);
  if (seen && now - seen < DEDUPE_TTL_MS) return true;
  recentlyProcessed.set(taskId, now);
  // opportunistic cleanup
  for (const [id, ts] of recentlyProcessed) {
    if (now - ts >= DEDUPE_TTL_MS) recentlyProcessed.delete(id);
  }
  return false;
}

// Build the CR title/comment from the inline task. Approvers are static config;
// title/comment derive from the task. The Automation payload has no creator
// email or task URL, so we reference name + id.
function buildCrMetadata(task) {
  const taskName = task?.name || `task ${task?.id}`;
  return {
    title: `RUM 100% request: ${taskName}`,
    comment: `Auto-requested from ClickUp task ${task?.id}.`,
  };
}

// Core handler, separated from the route wiring so it can be tested in-process
// with a mock req/res (and a mocked global fetch).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the workspace key(s). The Automation snapshot can race ahead of an
// auto-populated field, so if the inline payload has no key we wait and
// re-fetch the task from ClickUp a few times before giving up.
async function resolveWorkspaceKeys(task, taskId, workspace) {
  let keys = extractWorkspaceKeys(task);
  for (let i = 0; keys.length === 0 && i < workspace.maxRetries; i++) {
    await sleep(workspace.retryDelayMs);
    try {
      const fresh = await getTask(taskId);
      keys = extractWorkspaceKeys(fresh);
      log.info(
        `[webhook] task ${taskId}: re-fetch attempt ${i + 1}/${workspace.maxRetries} → ${keys.length ? `found ${keys.join(", ")}` : "still empty"}`,
      );
    } catch (err) {
      log.warn(`[webhook] task ${taskId}: re-fetch attempt ${i + 1} failed`, { taskId, err });
    }
  }
  return keys;
}

export async function handleWebhook(req, res) {
  const { auth, workspace, rerunField } = getConfig();
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from("");

  // Confirms the tunnel is delivering real traffic; never logs the header value.
  log.debug("[webhook] inbound request", {
    method: req.method,
    path: req.originalUrl,
    contentLength: rawBody.length,
    authHeaderPresent: !!req.get(auth.header),
  });

  if (!isValidToken(req.get(auth.header), auth.token)) {
    log.warn(`[webhook] rejected: missing/invalid ${auth.header}`);
    return res.status(401).json({ error: "unauthorized" });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid JSON" });
  }

  // Capture the full real payload locally (debug only) — this is what you read in
  // the `npm run dev` terminal when tunneling a live ClickUp delivery via ngrok.
  log.debug("[webhook] inbound payload", { body });

  // ClickUp Automation "Call webhook" embeds the full task under `payload`.
  const task = body?.payload;
  const taskId = task?.id;
  if (!taskId) return res.status(200).json({ ignored: "no task in payload" });

  // A checked "Retry RUM" field means a deliberate re-run: bypass the dedupe
  // guard so an immediate retry after a failure isn't swallowed.
  const rerun = getCheckboxField(task, rerunField);
  const isRerun = !!rerun?.checked;

  if (!isRerun && alreadyProcessed(taskId, Date.now())) {
    log.info(`[webhook] duplicate delivery for task ${taskId}, skipping`);
    return res.status(200).json({ ignored: "duplicate" });
  }
  if (isRerun) log.info(`[webhook] re-run requested for task ${taskId}`);

  // Compute a single result, then (for re-runs) reset the checkbox BEFORE
  // responding — Cloud Run can freeze CPU once the response is sent.
  let result;
  let keys = [];
  try {
    keys = await resolveWorkspaceKeys(task, taskId, workspace);
    if (keys.length === 0) {
      const msg = "❌ RUM auto-approve skipped: no workspace ID found in the configured custom field.";
      log.warn(`[webhook] task ${taskId}: ${msg}`);
      await safeComment(taskId, msg);
      result = { code: 200, body: { ignored: "no workspace id" } };
    } else {
      const meta = buildCrMetadata(task);
      const { crId } = await createSegmentKeyCR(keys, meta);
      await approveCR(crId);

      const ok = `✅ RUM 100% approved. Added workspace key(s) ${keys.join(", ")} to the segment. Change request ${crId} APPROVED.`;
      log.info(`[webhook] task ${taskId}: ${ok}`);
      await safeComment(taskId, ok);
      result = { code: 200, body: { ok: true, crId, keys } };
    }
  } catch (err) {
    if (err.status === 423) {
      // The segment already has a pending change request (expected lock).
      result = await handlePendingConflict(taskId, keys, err);
    } else {
      // Action already attempted — record failure on the task and ack (always
      // 200) so the Automation doesn't retry.
      const msg = `❌ RUM auto-approve failed: ${err.message}`;
      log.error(`[webhook] task ${taskId}: RUM auto-approve failed`, { taskId, err });
      await safeComment(taskId, msg);
      result = { code: 200, body: { ok: false, error: err.message } };
    }
  }

  if (isRerun && rerun.id) {
    try {
      await setCustomField(taskId, rerun.id, false);
    } catch (err) {
      log.error(`[webhook] failed to reset ${rerunField} on task ${taskId}`, { taskId, err });
    }
  }

  return res.status(result.code).json(result.body);
}

// `express.raw` gives us the exact bytes; the handler parses JSON itself.
router.post("/", express.raw({ type: "*/*" }), handleWebhook);

// FME locks the segment while a change request is pending, so create returns 423.
// Surface a trail comment, then approve the pending CR. If it's for the same
// workspace, that completes this task; if it's a different workspace, approving
// unblocks the queue and the user re-checks "Retry RUM" to process this task.
async function handlePendingConflict(taskId, keys, err) {
  const pendingId = parsePendingCrId(err.body);
  if (!pendingId) {
    const msg =
      'ℹ️ A pending RUM request already exists for this segment. Please approve it, then re-check "Retry RUM" to retry this task.';
    log.warn(`[webhook] task ${taskId}: 423 but no pending id parsed`, { taskId, err });
    await safeComment(taskId, msg);
    return { code: 200, body: { handled: "pending", pendingId: null } };
  }

  let sameWorkspace = false;
  try {
    const pendingCr = await getChangeRequest(pendingId);
    const pendingKeys = extractCrKeys(pendingCr);
    sameWorkspace = keys.some((k) => pendingKeys.includes(k));
  } catch (e) {
    log.warn(`[webhook] task ${taskId}: could not read pending CR ${pendingId}`, { taskId, err: e });
  }

  const trail = sameWorkspace
    ? `ℹ️ A pending RUM request for this Workspace already exists (change request ${pendingId}). Approving it now.`
    : `ℹ️ A pending RUM request for another Workspace is already in progress (change request ${pendingId}). Approving it to unblock the queue — re-check "Retry RUM" to process this request.`;
  log.info(`[webhook] task ${taskId}: ${trail}`);
  await safeComment(taskId, trail);

  try {
    await approveCR(pendingId);
    const ok = sameWorkspace
      ? `✅ RUM 100% approved for this Workspace. Change request ${pendingId} APPROVED.`
      : `✅ Approved the blocking change request ${pendingId}. Re-check "Retry RUM" on this task to process this Workspace.`;
    log.info(`[webhook] task ${taskId}: ${ok}`);
    await safeComment(taskId, ok);
    return { code: 200, body: { handled: "pending", pendingId, sameWorkspace, approved: true } };
  } catch (e) {
    const msg = `❌ Found pending change request ${pendingId} but failed to approve it: ${e.message}`;
    log.error(`[webhook] task ${taskId}: failed to approve pending change request ${pendingId}`, { taskId, err: e });
    await safeComment(taskId, msg);
    return { code: 200, body: { handled: "pending", pendingId, sameWorkspace, approved: false } };
  }
}

async function safeComment(taskId, text) {
  try {
    await addComment(taskId, text);
  } catch (err) {
    log.error(`[webhook] failed to post comment on task ${taskId}`, { taskId, err });
  }
}
