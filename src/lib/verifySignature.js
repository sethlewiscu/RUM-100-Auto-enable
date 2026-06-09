import crypto from "node:crypto";

// ClickUp signs each webhook delivery with HMAC-SHA256 over the *raw* request
// body, using the secret shown when the webhook was created. The hex digest is
// sent in the `X-Signature` header. We must hash the exact bytes received —
// re-serialized JSON will not match.
export function isValidSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signatureHeader), "utf8");

  // timingSafeEqual throws if lengths differ, so guard first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
