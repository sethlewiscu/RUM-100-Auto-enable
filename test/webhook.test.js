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
  process.env.SPLIT_BASE_URL = "https://split.example/api";
  process.env.CLICKUP_API_TOKEN = "pk_test";
  process.env.CLICKUP_BASE_URL = "https://clickup.example/api";
  process.env.WEBHOOK_AUTH_TOKEN = TOKEN;
  process.env.WORKSPACE_ID_FIELD = "Workspace ID [Perf]";
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

// Records every fetch and returns canned JSON depending on URL/method.
function installFetchMock() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, body: options.body, headers: options.headers });

    let json = {};
    if (url.includes("/changeRequests/ws/")) json = { id: "cr-999" }; // create CR
    else if (url.includes("/changeRequests/")) json = { status: "APPROVED" }; // approve
    else if (url.includes("/comment")) json = { id: "comment-1" }; // clickup comment

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(json),
    };
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
