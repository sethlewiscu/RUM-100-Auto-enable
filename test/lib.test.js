import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { isValidSignature } from "../src/lib/verifySignature.js";
import { extractChangeRequestId } from "../src/lib/split.js";

test("isValidSignature accepts a correct HMAC and rejects a tampered body", () => {
  const secret = "test-secret";
  const body = Buffer.from(JSON.stringify({ event: "taskCreated", task_id: "abc" }));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(isValidSignature(body, sig, secret), true);

  const tampered = Buffer.from(JSON.stringify({ event: "taskCreated", task_id: "xyz" }));
  assert.equal(isValidSignature(tampered, sig, secret), false);

  assert.equal(isValidSignature(body, "", secret), false);
  assert.equal(isValidSignature(body, sig, ""), false);
});

test("extractChangeRequestId handles the likely Split response shapes", () => {
  assert.equal(extractChangeRequestId({ id: "cr-1" }), "cr-1");
  assert.equal(extractChangeRequestId({ changeRequestId: "cr-2" }), "cr-2");
  assert.equal(extractChangeRequestId({ changeRequest: { id: "cr-3" } }), "cr-3");
  assert.equal(extractChangeRequestId({ nope: true }), null);
  assert.equal(extractChangeRequestId(null), null);
});
