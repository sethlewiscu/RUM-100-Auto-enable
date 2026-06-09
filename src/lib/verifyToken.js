import crypto from "node:crypto";

// The ClickUp Automation "Call webhook" action does not sign requests with an
// HMAC (unlike the subscription webhook API). Instead we have the Automation
// send a shared secret in a custom header (default X-Auth-Token) and compare it
// here in constant time.
export function isValidToken(provided, expected) {
  if (!provided || !expected) return false;

  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(String(expected), "utf8");

  // timingSafeEqual throws if lengths differ, so guard first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
