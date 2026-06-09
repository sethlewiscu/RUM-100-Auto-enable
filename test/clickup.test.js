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
  process.env.CLICKUP_WEBHOOK_SECRET = "secret";
  process.env.RUM_LIST_ID = "12345";
  process.env.WORKSPACE_ID_FIELD = "Workspace ID";
  resetConfig();
}

beforeEach(setEnv);

test("taskMatchesFilter / extractWorkspaceKeys read list + custom field", async () => {
  const { taskMatchesFilter, extractWorkspaceKeys } = await import("../src/lib/clickup.js");

  const task = {
    id: "1vj37mc",
    name: "Enable 100% RUM",
    list: { id: "12345" },
    custom_fields: [
      { id: "f1", name: "Workspace ID", value: "987654" },
      { id: "f2", name: "Other", value: "ignore" },
    ],
  };

  assert.equal(taskMatchesFilter(task), true);
  assert.deepEqual(extractWorkspaceKeys(task), ["987654"]);

  assert.equal(taskMatchesFilter({ ...task, list: { id: "99999" } }), false);
  assert.deepEqual(extractWorkspaceKeys({ ...task, custom_fields: [] }), []);

  // comma-separated multi-value support
  const multi = { ...task, custom_fields: [{ name: "Workspace ID", value: "1, 2 ,3" }] };
  assert.deepEqual(extractWorkspaceKeys(multi), ["1", "2", "3"]);
});
