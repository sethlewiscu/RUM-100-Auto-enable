import express from "express";
import { isValidToken } from "../lib/verifyToken.js";
import { getConfig } from "../lib/config.js";
import { addComment, extractWorkspaceKeys, getTask } from "../lib/clickup.js";
import { createSegmentKeyCR, approveCR } from "../lib/split.js";

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
      console.log(
        `[webhook] task ${taskId}: re-fetch attempt ${i + 1}/${workspace.maxRetries} → ${keys.length ? `found ${keys.join(", ")}` : "still empty"}`,
      );
    } catch (err) {
      console.warn(`[webhook] task ${taskId}: re-fetch attempt ${i + 1} failed: ${err.message}`);
    }
  }
  return keys;
}

export async function handleWebhook(req, res) {
  const { auth, workspace } = getConfig();
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from("");

  if (!isValidToken(req.get(auth.header), auth.token)) {
    console.warn(`[webhook] rejected: missing/invalid ${auth.header}`);
    return res.status(401).json({ error: "unauthorized" });
  }

  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid JSON" });
  }

  // ClickUp Automation "Call webhook" embeds the full task under `payload`.
  const task = body?.payload;
  const taskId = task?.id;
  if (!taskId) return res.status(200).json({ ignored: "no task in payload" });

  const now = Date.now();
  if (alreadyProcessed(taskId, now)) {
    console.log(`[webhook] duplicate delivery for task ${taskId}, skipping`);
    return res.status(200).json({ ignored: "duplicate" });
  }

  try {
    const keys = await resolveWorkspaceKeys(task, taskId, workspace);
    if (keys.length === 0) {
      const msg = "❌ RUM auto-approve skipped: no workspace ID found in the configured custom field.";
      console.warn(`[webhook] task ${taskId}: ${msg}`);
      await safeComment(taskId, msg);
      return res.status(200).json({ ignored: "no workspace id" });
    }

    const meta = buildCrMetadata(task);
    const { crId } = await createSegmentKeyCR(keys, meta);
    await approveCR(crId);

    const ok = `✅ RUM 100% approved. Added workspace key(s) ${keys.join(", ")} to the segment. Change request ${crId} APPROVED.`;
    console.log(`[webhook] task ${taskId}: ${ok}`);
    await safeComment(taskId, ok);

    return res.status(200).json({ ok: true, crId, keys });
  } catch (err) {
    // Action already attempted — record failure on the task and ack so we don't
    // loop on retries.
    const msg = `❌ RUM auto-approve failed: ${err.message}`;
    console.error(`[webhook] task ${taskId}: ${msg}`);
    await safeComment(taskId, msg);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// `express.raw` gives us the exact bytes; the handler parses JSON itself.
router.post("/", express.raw({ type: "*/*" }), handleWebhook);

async function safeComment(taskId, text) {
  try {
    await addComment(taskId, text);
  } catch (err) {
    console.error(`[webhook] failed to post comment on task ${taskId}: ${err.message}`);
  }
}
