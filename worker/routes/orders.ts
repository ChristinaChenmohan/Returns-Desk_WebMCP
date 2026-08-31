import { OrderService } from "../domain/order-service";
import { DemoCommerceAdapter } from "../demo/demo-commerce-adapter";
import { PolicyReadService } from "../domain/policy-read-service";
import { searchOrdersInput, getReturnPolicyInput } from "../../src/shared/contracts/tools";
import { z } from "zod";
import { parse, params, query, type RouteKit } from "./shared";
export function orderRoutes(k: RouteKit) {
  const orders = new OrderService(new DemoCommerceAdapter(k.db));
  k.get("/orders", "orders.search", async c => k.ok(c, await orders.search(parse(searchOrdersInput.extend({ limit: z.coerce.number().int().min(1).max(5).default(5) }), query(c)), c.get("requestContext"))));
  k.get("/orders/:orderId", "orders.read", async c => k.ok(c, await orders.get(params(c, "orderId"), c.get("requestContext"))));
  k.get("/order-items/:orderItemId/return-policy", "policy.read", async c => k.ok(c, await new PolicyReadService(k.db).getLockedPolicy(
    parse(getReturnPolicyInput, { ...query(c), orderItemId: params(c, "orderItemId") }), c.get("requestContext"))));
}
