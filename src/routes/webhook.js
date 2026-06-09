import express from "express";
import { isValidSignature } from "../lib/verifySignature.js";
import { getConfig } from "../lib/config.js";
import {
  getTask,
  addComment,
  taskMatchesFilter,
  extractWorkspaceKeys,
} from "../lib/clickup.js";
import { createSegmentKeyCR, approveCR } from "../lib/split.js";

export const router = express.Router();

// Short-lived in-memory dedupe so ClickUp retries (it re-delivers on non-2xx)
// don't create duplicate change requests for the same task.
const recentlyProcessed = new Map(); // task_id -> timestamp(ms)
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

// Build the CR title/comment from task context (the "mix" decision: approvers
// are static config, title/comment derive from the task).
function buildCrMetadata(task, payload) {
  const requester =
    payload?.history_items?.[0]?.user?.email || payload?.history_items?.[0]?.user?.username || "unknown";
  const taskName = task?.name || `task ${task?.id}`;
  return {
    title: `RUM 100% request: ${taskName}`,
    comment: `Auto-requested from ClickUp task ${task?.url || task?.id} (requested by ${requester}).`,
  };
}

// `express.raw` gives us the exact bytes for signature verification. We parse
// JSON ourselves afterward.
router.post("/clickup", express.raw({ type: "*/*" }), async (req, res) => {
  const { clickup } = getConfig();
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from("");

  if (!isValidSignature(rawBody, req.get("X-Signature"), clickup.webhookSecret)) {
    console.warn("[webhook] rejected: invalid X-Signature");
    return res.status(401).json({ error: "invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid JSON" });
  }

  // Only act on task creation; ack everything else so ClickUp stops retrying.
  if (payload.event !== "taskCreated") {
    return res.status(200).json({ ignored: `event ${payload.event}` });
  }

  const taskId = payload.task_id;
  if (!taskId) return res.status(200).json({ ignored: "no task_id" });

  const now = Date.now();
  if (alreadyProcessed(taskId, now)) {
    console.log(`[webhook] duplicate delivery for task ${taskId}, skipping`);
    return res.status(200).json({ ignored: "duplicate" });
  }

  try {
    const task = await getTask(taskId);

    if (!taskMatchesFilter(task)) {
      console.log(`[webhook] task ${taskId} not in target list/space, skipping`);
      return res.status(200).json({ ignored: "out of scope" });
    }

    const keys = extractWorkspaceKeys(task);
    if (keys.length === 0) {
      const msg = "❌ RUM auto-approve skipped: no workspace ID found in the configured custom field.";
      console.warn(`[webhook] task ${taskId}: ${msg}`);
      await safeComment(taskId, msg);
      return res.status(200).json({ ignored: "no workspace id" });
    }

    const meta = buildCrMetadata(task, payload);
    const { crId } = await createSegmentKeyCR(keys, meta);
    await approveCR(crId);

    const ok = `✅ RUM 100% approved. Added workspace key(s) ${keys.join(", ")} to the segment. Change request ${crId} APPROVED.`;
    console.log(`[webhook] task ${taskId}: ${ok}`);
    await safeComment(taskId, ok);

    return res.status(200).json({ ok: true, crId, keys });
  } catch (err) {
    // Action already attempted — record failure on the task and ack so we don't
    // loop on retries. (Use 5xx only for truly transient/unknown failures.)
    const msg = `❌ RUM auto-approve failed: ${err.message}`;
    console.error(`[webhook] task ${taskId}: ${msg}`);
    await safeComment(taskId, msg);
    return res.status(200).json({ ok: false, error: err.message });
  }
});

async function safeComment(taskId, text) {
  try {
    await addComment(taskId, text);
  } catch (err) {
    console.error(`[webhook] failed to post comment on task ${taskId}: ${err.message}`);
  }
}
