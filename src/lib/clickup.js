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

// Every public comment is prefixed with an [AUTO-REPLY] marker: the service
// currently posts under a personal API key (not the service bot), so this makes
// clear the comment is automated and not hand-written. ClickUp's comment_text is
// plain text (backticks render literally), so we use the structured `comment`
// array — the marker as an inline-code segment, then the message as plain text.
export function addComment(taskId, commentText) {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}/comment`, {
    method: "POST",
    body: JSON.stringify({
      comment: [
        { text: "[AUTO-REPLY]", attributes: { code: true } },
        { text: `\n${commentText}`, attributes: {} },
      ],
      notify_all: false,
    }),
  });
}

// Set a custom field value on a task. For a checkbox, pass a boolean.
export function setCustomField(taskId, fieldId, value) {
  return clickupFetch(
    `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
    { method: "POST", body: JSON.stringify({ value }) },
  );
}

// Set the task's workflow status (e.g. "Needs TIM"). The status must exist in
// the task's list/space, otherwise ClickUp responds 400.
export function setTaskStatus(taskId, status) {
  return clickupFetch(`/task/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body: JSON.stringify({ status }),
  });
}

// Add a tag to a task. ClickUp creates the tag if the space allows it.
export function addTag(taskId, tagName) {
  return clickupFetch(
    `/task/${encodeURIComponent(taskId)}/tag/${encodeURIComponent(tagName)}`,
    { method: "POST" },
  );
}

// Find a custom field by id OR (case-insensitive) name and report whether it's
// a checked checkbox. Returns { id, checked } or null when the field is absent.
export function getCheckboxField(task, nameOrId) {
  const fields = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  const field = fields.find(
    (f) =>
      String(f.id) === nameOrId ||
      String(f.name || "").toLowerCase() === String(nameOrId).toLowerCase(),
  );
  if (!field) return null;

  const v = field.value;
  const checked = v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
  return { id: field.id, checked };
}

// A valid Split workspace key is all digits (e.g. "123456"). Numbers in the
// custom field arrive as strings post-trim; reject anything else.
export function findInvalidKeys(keys) {
  return keys.filter((k) => !/^\d+$/.test(k));
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
