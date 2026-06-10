import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resetConfig } from "../src/lib/config.js";
import { handleWebhook } from "../src/routes/webhook.js";

const TOKEN = "secret-token";

function setEnv() {
  process.env.SPLIT_API_TOKEN = "sat.test";
  process.env.SPLIT_WS_ID = "ws-1";
  process.env.SPLIT_ENV_ID = "env-1";
  process.env.SPLIT_APPROVERS = "a@x.com";
  process.env.SPLIT_APPROVE_TOKEN = "sat.approve";
  process.env.SPLIT_BASE_URL = "https://split.example/api";
  process.env.CLICKUP_API_TOKEN = "pk_test";
  process.env.CLICKUP_BASE_URL = "https://clickup.example/api";
  process.env.WEBHOOK_AUTH_TOKEN = TOKEN;
  process.env.WORKSPACE_ID_FIELD = "Workspace ID [Perf]";
  process.env.RERUN_FIELD = "rf1"; // match the rerun field by id (see rerunBody)
  process.env.WORKSPACE_RETRY_DELAY_MS = "0"; // instant retries in tests
  process.env.WORKSPACE_MAX_RETRIES = "3";
  resetConfig();
}

const realFetch = globalThis.fetch;
beforeEach(setEnv);
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Build a ClickUp Automation "Call webhook" body with a workspace key set.
function automationBody(taskId = "868djdyr0", wsKey = "555111") {
  return {
    auto_id: "auto:main",
    trigger_id: "trig-1",
    date: "2025-04-16T23:49:06.457Z",
    payload: {
      id: taskId,
      name: "Enable RUM",
      custom_fields: [
        { id: "f1", name: "Workspace ID [Perf]", type: "text", value: wsKey },
      ],
    },
  };
}

// Same body, plus a "Retry RUM" checkbox custom field (re-run trigger).
function rerunBody(taskId, wsKey, checked) {
  const b = automationBody(taskId, wsKey);
  b.payload.custom_fields.push({ id: "rf1", name: "Retry RUM", type: "checkbox", value: checked });
  return b;
}

function mockReq(body, token) {
  return {
    body: Buffer.from(JSON.stringify(body)),
    get: (h) => (h === "X-Auth-Token" ? token : undefined),
  };
}

function mockRes() {
  return {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.payload = obj;
      return this;
    },
  };
}

const PENDING_ID = "7f69afb0-6450-11f1-8874-a2ae3133ca1f";

// Records every fetch and returns canned JSON depending on URL/method.
// Options:
//   refetchTask  – what a GET /task/{id} re-fetch returns (default empty task)
//   createStatus – HTTP status for the create POST (use 423 to simulate a lock)
//   pendingCr    – CR returned by GET /changeRequests/{id}
//   pendingId    – id embedded in the 423 "details" message
function installFetchMock({ refetchTask = {}, createStatus = 200, pendingCr = null, pendingId = PENDING_ID } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body, headers: options.headers });
    const ok = (json, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(json) });

    // Split: create change request (POST .../changeRequests/ws/...)
    if (url.includes("/changeRequests/ws/")) {
      if (createStatus !== 200) {
        const body = JSON.stringify({
          code: createStatus,
          message: "Something was wrong",
          details: `A pending change request with id:${pendingId} for this object already exists`,
        });
        return { ok: false, status: createStatus, text: async () => body };
      }
      return ok({ id: "cr-999" });
    }

    // Split: GET a specific CR, or PUT to approve it (.../changeRequests/{id})
    if (url.includes("/changeRequests/")) {
      return method === "GET" ? ok(pendingCr || {}) : ok({ status: "APPROVED" });
    }

    if (url.includes("/comment")) return ok({ id: "comment-1" }); // clickup comment
    if (method === "GET" && url.includes("/task/")) return ok(refetchTask); // re-fetch

    return ok({});
  };
  return calls;
}

test("happy path: create CR, approve it, comment back", async () => {
  const calls = installFetchMock();
  const res = mockRes();

  await handleWebhook(mockReq(automationBody(), TOKEN), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.crId, "cr-999");
  assert.deepEqual(res.payload.keys, ["555111"]);

  const create = calls.find((c) => c.url.includes("/changeRequests/ws/"));
  const approve = calls.find((c) => c.method === "PUT" && c.url.includes("/changeRequests/cr-999"));
  const comment = calls.find((c) => c.url.includes("/comment"));

  assert.ok(create, "should call Split create-CR");
  assert.ok(JSON.parse(create.body).segment.keys.includes("555111"), "create body carries the key");
  assert.ok(approve, "should approve the returned CR id");
  assert.ok(comment, "should post a result comment");
  assert.match(JSON.parse(comment.body).comment_text, /APPROVED/);

  // Create uses SPLIT_API_TOKEN; approve uses the distinct SPLIT_APPROVE_TOKEN,
  // both via the x-api-key header.
  assert.equal(create.headers["x-api-key"], "sat.test");
  assert.equal(approve.headers["x-api-key"], "sat.approve");
});

test("race: inline value empty, re-fetch finds the key, then proceeds", async () => {
  const refetched = {
    id: "race-task",
    name: "Enable RUM",
    custom_fields: [{ name: "Workspace ID [Perf]", type: "text", value: "777999" }],
  };
  const calls = installFetchMock({ refetchTask: refetched });
  const res = mockRes();

  const body = automationBody("race-task");
  body.payload.custom_fields = []; // inline empty -> forces a re-fetch

  await handleWebhook(mockReq(body, TOKEN), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.deepEqual(res.payload.keys, ["777999"]);
  assert.ok(
    calls.some((c) => c.method === "GET" && c.url.includes("/task/race-task")),
    "should re-fetch the task from ClickUp",
  );
  assert.ok(calls.some((c) => c.url.includes("/changeRequests/ws/")), "creates the CR");
});

test("rejects a request with a wrong token (401, no fetch)", async () => {
  const calls = installFetchMock();
  const res = mockRes();

  await handleWebhook(mockReq(automationBody("diff-task"), "WRONG"), res);

  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0, "must not call any downstream API on auth failure");
});

test("no workspace id -> skip with failure comment, no Split calls", async () => {
  const calls = installFetchMock();
  const res = mockRes();

  const body = automationBody("no-ws-task");
  body.payload.custom_fields = []; // field missing

  await handleWebhook(mockReq(body, TOKEN), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ignored, "no workspace id");
  assert.ok(!calls.some((c) => c.url.includes("/changeRequests")), "no Split calls");
  assert.ok(calls.some((c) => c.url.includes("/comment")), "posts a skip comment");
});

test("re-run (Retry RUM checked): bypasses dedupe and auto-unchecks the box", async () => {
  const calls = installFetchMock();

  // Two deliveries with the SAME task id; both are re-runs and must both process.
  await handleWebhook(mockReq(rerunBody("rerun-task", "111", true), TOKEN), mockRes());
  const res2 = mockRes();
  await handleWebhook(mockReq(rerunBody("rerun-task", "111", true), TOKEN), res2);

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.payload.ok, true, "re-run reprocesses even with a repeated task id");

  // Auto-uncheck: POST /task/rerun-task/field/rf1 with value:false on each run.
  const unchecks = calls.filter(
    (c) => c.method === "POST" && c.url.includes("/task/rerun-task/field/rf1"),
  );
  assert.ok(unchecks.length >= 2, "unchecks Retry RUM after each run");
  assert.equal(JSON.parse(unchecks[0].body).value, false);
});

test("dedupe still applies to normal (non-re-run) deliveries", async () => {
  installFetchMock();

  await handleWebhook(mockReq(automationBody("dup-task", "222"), TOKEN), mockRes());
  const res2 = mockRes();
  await handleWebhook(mockReq(automationBody("dup-task", "222"), TOKEN), res2);

  assert.equal(res2.payload.ignored, "duplicate");
});

test("423 pending CR for SAME workspace: trail comment, approve it, success", async () => {
  const pendingCr = {
    id: PENDING_ID,
    status: "REQUESTED",
    segment: { name: "RUM100Perc_Workspaces", keys: ["555111"] },
  };
  const calls = installFetchMock({ createStatus: 423, pendingCr });
  const res = mockRes();

  await handleWebhook(mockReq(automationBody("same-ws-task", "555111"), TOKEN), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.handled, "pending");
  assert.equal(res.payload.sameWorkspace, true);
  assert.equal(res.payload.approved, true);

  assert.ok(
    calls.some((c) => c.method === "PUT" && c.url.includes(`/changeRequests/${PENDING_ID}`)),
    "approves the pending CR",
  );
  const comments = calls
    .filter((c) => c.url.includes("/comment"))
    .map((c) => JSON.parse(c.body).comment_text);
  assert.ok(comments.some((t) => /already exists/i.test(t)), "posts the trail comment");
  assert.ok(comments.some((t) => /APPROVED/.test(t)), "posts the success comment");
});

test("423 pending CR for DIFFERENT workspace: approve blocker + retry guidance", async () => {
  const pendingCr = {
    id: PENDING_ID,
    status: "REQUESTED",
    segment: { name: "RUM100Perc_Workspaces", keys: ["999999"] },
  };
  const calls = installFetchMock({ createStatus: 423, pendingCr });
  const res = mockRes();

  await handleWebhook(mockReq(automationBody("diff-ws-task", "111111"), TOKEN), res);

  assert.equal(res.payload.sameWorkspace, false);
  assert.equal(res.payload.approved, true);
  assert.ok(
    calls.some((c) => c.method === "PUT" && c.url.includes(`/changeRequests/${PENDING_ID}`)),
    "approves the blocking CR",
  );
  const comments = calls
    .filter((c) => c.url.includes("/comment"))
    .map((c) => JSON.parse(c.body).comment_text);
  assert.ok(comments.some((t) => /another Workspace/i.test(t)), "trail mentions another workspace");
  assert.ok(comments.some((t) => /Retry RUM/i.test(t)), "guides retry via Retry RUM");
});
