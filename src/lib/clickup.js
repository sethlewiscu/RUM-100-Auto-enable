import { getConfig } from "./config.js";

// Thin wrapper around the ClickUp REST API. The taskCreated webhook only gives
// us a task_id, so we fetch the full task to read the workspace-ID custom field
// and figure out which list/space it belongs to.

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

export function getTask(taskId) {
  // include custom fields; ClickUp returns them by default on the task object.
  return clickupFetch(`/task/${encodeURIComponent(taskId)}`);
}

export function addComment(taskId, commentText) {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: commentText, notify_all: false }),
  });
}

// True if the task belongs to the configured RUM list and/or space. If only one
// of listId/spaceId is configured, only that one is checked.
export function taskMatchesFilter(task) {
  const { filter } = getConfig();
  const listOk = filter.listId ? String(task?.list?.id) === filter.listId : true;
  const spaceOk = filter.spaceId ? String(task?.space?.id) === filter.spaceId : true;
  return listOk && spaceOk;
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
