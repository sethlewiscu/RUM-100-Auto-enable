import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidToken } from "../src/lib/verifyToken.js";
import { extractChangeRequestId } from "../src/lib/split.js";

test("isValidToken accepts a matching token and rejects mismatches", () => {
  const secret = "super-secret-token";

  assert.equal(isValidToken(secret, secret), true);
  assert.equal(isValidToken("wrong", secret), false);
  assert.equal(isValidToken("", secret), false);
  assert.equal(isValidToken(secret, ""), false);
  assert.equal(isValidToken(undefined, secret), false);
  // different lengths must not throw
  assert.equal(isValidToken("short", "a-much-longer-secret"), false);
});

test("extractChangeRequestId handles the likely Split response shapes", () => {
  assert.equal(extractChangeRequestId({ id: "cr-1" }), "cr-1");
  assert.equal(extractChangeRequestId({ changeRequestId: "cr-2" }), "cr-2");
  assert.equal(extractChangeRequestId({ changeRequest: { id: "cr-3" } }), "cr-3");
  assert.equal(extractChangeRequestId({ nope: true }), null);
  assert.equal(extractChangeRequestId(null), null);
});
