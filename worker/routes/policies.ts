import { z } from "zod";
import { resolutionType } from "../../src/shared/contracts/common";
import { PolicyAdminService, type UpdatePolicyDraft } from "../domain/policy-admin-service";
import { command, human, id, keySchema, pageSchema, params, parse, query, version, type RouteKit } from "./shared";
const draft = z.object({ name: z.string().trim().min(1).max(120), defaultWindowDays: z.number().int().min(0).max(3650),
  absoluteMaxWindowDays: z.number().int().min(0).max(3650), defaultReturnRequired: z.boolean(), defaultResolutions: z.array(resolutionType).min(1).max(3),
  returnShippingPayer: z.enum(["merchant", "customer"]), rules: z.array(z.object({ id, ruleType: z.enum(["delivery_required", "quantity_limit", "return_window", "category_window", "final_sale", "condition_requirement", "reason_exception", "resolution_allowlist", "return_shipping", "return_required", "store_credit_bonus", "manual_review"]),
    priority: z.number().int(), conditions: z.record(z.string(), z.unknown()), outcome: z.record(z.string(), z.unknown()), explanation: z.string().min(1).max(500), active: z.boolean() }).strict()).max(50), idempotencyKey: keySchema }).strict();
export function policyRoutes(k: RouteKit) {
  const policies = new PolicyAdminService(k.db, k.clock, k.ids);
  k.get("/policy-versions", "policy.read", async c => k.ok(c, await policies.list(parse(pageSchema.extend({ status: z.enum(["draft", "active", "retired"]).optional() }), query(c)) as Parameters<PolicyAdminService["list"]>[0], c.get("requestContext"))));
  k.get("/policy-versions/:policyId", "policy.read", async c => k.ok(c, await policies.loadVersion(params(c, "policyId"), c.get("requestContext").sessionId)));
  k.write("post", "/policy-versions", "policy.write.human", async c => {
    const input = command(c, draft); const status = await k.created(c, "policy.create");
    const result = await policies.createDraft(input, human(c));
    return k.ok(c, result, [{ entityType: "policy_version", entityId: result.id, entityVersion: result.version }], status);
  });
  k.write("patch", "/policy-versions/:policyId", "policy.write.human", async c => {
    const result = await policies.updateDraft(command(c, draft.extend({ id, expectedVersion: version }), { id: params(c, "policyId") }) as UpdatePolicyDraft, human(c));
    return k.ok(c, result, [{ entityType: "policy_version", entityId: result.id, entityVersion: result.version }]);
  });
  k.write("post", "/policy-versions/:policyId/validate", "policy.write.human", async c => {
    command(c, z.object({}).strict(), {}, false);
    return k.ok(c, await policies.validateDraft(params(c, "policyId"), human(c)));
  });
  k.write("post", "/policy-versions/:policyId/activate", "policy.activate.human", async c => {
    const result = await policies.activate(command(c, z.object({ id, expectedVersion: version, idempotencyKey: keySchema }).strict(), { id: params(c, "policyId") }), human(c));
    return k.ok(c, result, [{ entityType: "policy_version", entityId: result.id, entityVersion: result.version }]);
  });
}
