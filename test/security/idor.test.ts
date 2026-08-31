import { expect, it } from "vitest";
import { db } from "../integration/setup";
import { apiFixture } from "../fixtures/api";
it("returns identical missing and cross-session resource errors", async () => {
  const a = await apiFixture(db), b = await apiFixture(db);
  const search = await (await a.request("/orders?query=ORD-1001")).json() as { data: { orders: { orderId: string }[] } };
  const foreign = await b.request(`/orders/${search.data.orders[0]!.orderId}`), missing = await b.request("/orders/missing");
  expect(foreign.status).toBe(404); expect(missing.status).toBe(404);
  const error = (body: unknown) => { const { correlationId: _, ...rest } = (body as { error: Record<string, unknown> }).error; return rest; };
  expect(error(await foreign.json())).toEqual(error(await missing.json()));
  const policies = await (await a.request("/policy-versions")).json() as { data: { items: { id: string }[] } };
  expect((await b.request(`/policy-versions/${policies.data.items[0]!.id}`)).status).toBe(404);
});

