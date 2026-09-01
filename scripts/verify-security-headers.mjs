import assert from "node:assert/strict";

const value = process.argv[2];
if (!value) throw new Error("Usage: node scripts/verify-security-headers.mjs BASE_URL");
const base = new URL(value);
if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") throw new Error("BASE_URL must be HTTPS (localhost is allowed).");
const [page, bootstrap] = await Promise.all([
  fetch(new URL("/", base)),
  fetch(new URL("/api/v1/session/bootstrap", base)),
]);
assert.equal(page.status, 200);
assert.equal(bootstrap.status, 200);
for (const response of [page, bootstrap]) {
  assert.match(response.headers.get("content-security-policy") ?? "", /object-src 'none'/u);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("referrer-policy"));
}
assert.match(bootstrap.headers.get("set-cookie") ?? "", /HttpOnly/u);
assert.match(bootstrap.headers.get("set-cookie") ?? "", /Secure/u);
assert.match(bootstrap.headers.get("set-cookie") ?? "", /SameSite=Lax/u);
console.log("Security header verification passed.");
