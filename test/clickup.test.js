import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { resetConfig } from "../src/lib/config.js";

// Minimal env so getConfig() succeeds inside the clickup helpers.
function setEnv() {
  process.env.SPLIT_API_TOKEN = "sat.test";
  process.env.SPLIT_WS_ID = "ws";
  process.env.SPLIT_ENV_ID = "env";
  process.env.SPLIT_APPROVERS = "a@x.com";
  process.env.CLICKUP_API_TOKEN = "pk_test";
  process.env.WEBHOOK_AUTH_TOKEN = "secret";
  process.env.WORKSPACE_ID_FIELD = "Workspace ID [Perf]";
  resetConfig();
}

beforeEach(setEnv);

test("extractWorkspaceKeys reads the field from the Automation task payload", async () => {
  const { extractWorkspaceKeys } = await import("../src/lib/clickup.js");

  // Shape of `payload` inside a ClickUp Automation "Call webhook" body.
  const task = {
    id: "868djdyr0",
    name: "Enable 100% RUM",
    custom_fields: [
      { id: "f1", name: "Workspace ID [Perf]", type: "text", value: "987654" },
      { id: "f2", name: "RUM Sampling Enabled?", type: "checkbox", value: "false" },
    ],
  };

  assert.deepEqual(extractWorkspaceKeys(task), ["987654"]);

  // missing / empty field
  assert.deepEqual(extractWorkspaceKeys({ ...task, custom_fields: [] }), []);

  // comma-separated multi-value support
  const multi = {
    ...task,
    custom_fields: [{ name: "Workspace ID [Perf]", value: "1, 2 ,3" }],
  };
  assert.deepEqual(extractWorkspaceKeys(multi), ["1", "2", "3"]);
});

test("findInvalidKeys flags anything that isn't all-digits", async () => {
  const { findInvalidKeys } = await import("../src/lib/clickup.js");

  assert.deepEqual(findInvalidKeys(["123456"]), []);
  assert.deepEqual(findInvalidKeys(["007"]), []); // leading zeros are fine
  assert.deepEqual(findInvalidKeys(["TEST"]), ["TEST"]);
  assert.deepEqual(findInvalidKeys(["123456", "TEST"]), ["TEST"]);
  assert.deepEqual(findInvalidKeys(["12.3", "1e5", "-5"]), ["12.3", "1e5", "-5"]);
});
