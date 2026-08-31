import { expect, it } from "vitest";
import { db } from "../integration/setup";
import { apiFixture } from "../fixtures/api";
it("serves the dashboard and all list endpoints as JSON envelopes", async () => {
  const f = await apiFixture(db);
  for (const route of ["/dashboard", "/orders?query=ORD&limit=5", "/cases", "/approval-queue", "/policy-versions"]) {
    const response = await f.request(route);
    expect(response.status, route).toBe(200);
    expect(await response.json()).toMatchObject({ data: expect.any(Object), meta: { seedVersion: 1 } });
  }
});
