import { expect, it } from "vitest";
import { db } from "../integration/setup";
import { apiFixture } from "../fixtures/api";
import { rateLimitDigest } from "../../worker/http/rate-limit";
it("limits search independently, returns bounded retry and isolates sessions", async () => {
  const a = await apiFixture(db), b = await apiFixture(db);
  for (let i = 0; i < 60; i++) expect((await a.request("/orders?query=ORD")).status).toBe(200);
  const limited = await a.request("/orders?query=ORD"); expect(limited.status).toBe(429); expect(limited.headers.get("Retry-After")).toBe("60");
  expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED", retryable: true } });
  expect((await b.request("/orders?query=ORD")).status).toBe(200);
  expect((await a.request("/policy-versions", "POST", {})).status).toBe(400);
}, 30_000);
it("hashes a coarse address with session identity without storing the address", async () => {
  const a = await rateLimitDigest("session-a", "192.0.2.10");
  expect(a).toMatch(/^[a-f0-9]{64}$/); expect(await rateLimitDigest("session-a", "192.0.2.99")).toBe(a);
  expect(await rateLimitDigest("session-b", "192.0.2.10")).not.toBe(a);
});
