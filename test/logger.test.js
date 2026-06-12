import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeError, tokenType } from "../src/lib/logger.js";

test("serializeError captures message, stack, and enriched Split props", () => {
  const err = new Error("Split PUT /changeRequests/abc failed: 401 nope");
  err.status = 401;
  err.method = "PUT";
  err.path = "/changeRequests/abc";
  err.body = { code: 401, message: "Unauthorized" };
  err.headers = { transactionid: "txn-123" };

  const out = serializeError(err);
  assert.equal(out.message, err.message);
  assert.ok(out.stack.includes("Error: Split PUT"), "keeps the full stack");
  assert.equal(out.status, 401);
  assert.equal(out.method, "PUT");
  assert.equal(out.path, "/changeRequests/abc");
  assert.deepEqual(out.body, { code: 401, message: "Unauthorized" });
  assert.deepEqual(out.headers, { transactionid: "txn-123" });
});

test("serializeError passes non-Errors through unchanged", () => {
  assert.equal(serializeError("just a string"), "just a string");
  assert.deepEqual(serializeError({ a: 1 }), { a: 1 });
});

test("tokenType exposes only the type prefix, never the secret", () => {
  assert.equal(tokenType("sat.supersecretvalue"), "sat.");
  assert.equal(tokenType("pat.anothersecret"), "pat.");
  assert.equal(tokenType(""), "(unset)");
  assert.equal(tokenType(undefined), "(unset)");
});
