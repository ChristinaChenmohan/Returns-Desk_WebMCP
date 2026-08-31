import { z } from "zod";
import { reasonCode, conditionCode } from "../../src/shared/contracts/common";
import { CaseQueryService } from "../domain/case-query-service";
import { CaseCreateService, type CreateCase } from "../domain/case-create-service";
import { caseEffect, command, human, id, keySchema, pageSchema, params, parse, query, type RouteKit } from "./shared";
export function caseRoutes(k: RouteKit) {
  const cases = new CaseQueryService(k.db, k.clock, k.ids);
  k.get("/cases", "cases.read", async c => k.ok(c, await cases.list(parse(pageSchema.extend({ status: z.enum(["open", "closed"]).optional() }), query(c)) as Parameters<CaseQueryService["list"]>[0], c.get("requestContext"))));
  k.get("/cases/:caseId", "cases.read", async c => k.ok(c, await cases.getWorkspace(params(c, "caseId"), c.get("requestContext"))));
  k.get("/cases/:caseId/activity", "audit.read", async c => k.ok(c, await cases.getActivity(params(c, "caseId"), parse(pageSchema, query(c)) as Parameters<CaseQueryService["getActivity"]>[1], c.get("requestContext"))));
  k.write("post", "/cases", "cases.create", async c => {
    const input = command(c, z.object({ orderId: id, reasonCode, conditionCode, customerNote: z.string().max(1000).optional(), idempotencyKey: keySchema }).strict()) as CreateCase;
    const status = await k.created(c, "case.create");
    const { sessionId: _session, customerId: _customer, ...result } = await new CaseCreateService(k.db, k.clock, k.ids).create(input, human(c));
    return k.ok(c, { ...result, caseId: result.id }, caseEffect(result.id, result.version), status);
  });
}
