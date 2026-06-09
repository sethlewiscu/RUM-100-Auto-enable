import { getConfig } from "./config.js";

// Thin wrapper around the ClickUp REST API. The Automation payload embeds the
// task inline, but its snapshot can be captured before an auto-populated field
// settles — so we re-fetch the task (getTask) to read the settled value, and
// post the result comment back on the task.

async function clickupFetch(path, options = {}) {
  const { clickup } = getConfig();
  const res = await fetch(`${clickup.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: clickup.apiToken,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ClickUp ${options.method || "GET"} ${path} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// Fetch the full task; custom_fields are included on the task object. Used to
// re-read the workspace-ID field when the inline payload snapshot was empty.
export function getTask(taskId) {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}`);
}

export function addComment(taskId, commentText) {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: commentText, notify_all: false }),
  });
}

// Reads the workspace ID(s) from the configured custom field. Matches the field
// by id OR (case-insensitive) name. Returns an array of non-empty string keys.
export function extractWorkspaceKeys(task) {
  const { workspaceIdField } = getConfig();
  const fields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];

  const field = fields.find(
    (f) =>
      String(f.id) === workspaceIdField ||
      String(f.name || "").toLowerCase() === workspaceIdField.toLowerCase(),
  );

  if (!field || field.value === undefined || field.value === null || field.value === "") {
    return [];
  }

  // Support single value, comma-separated string, or array values.
  const raw = Array.isArray(field.value) ? field.value : String(field.value).split(",");
  return raw.map((v) => String(v).trim()).filter(Boolean);
}
