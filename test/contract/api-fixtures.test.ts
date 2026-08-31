import { expect, it } from "vitest";
import { db } from "../integration/setup";
import { apiFixture, apiOrigin } from "../fixtures/api";
import type { OrderSearchResult } from "../../worker/domain/order-service";
import type { OrderDetails } from "../../worker/domain/commerce-adapter";
import type { EligibilityResult } from "../../worker/domain/eligibility-service";
import type { MessageDraft } from "../../worker/domain/message-service";
import type { ProposalResult } from "../../worker/domain/proposal-service";
import type { ApprovalResult } from "../../worker/domain/approval-service";
import type { PolicyVersion } from "../../worker/domain/policy-admin-service";

async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body).toMatchObject({ meta: { requestId: expect.any(String), serverTime: expect.any(String), seedVersion: 1 } });
  return (body as { data: T }).data;
}
export async function returnFlow(f: Awaited<ReturnType<typeof apiFixture>>) {
  const search = await json<OrderSearchResult>(await f.request("/orders?query=ORD-1001"));
  const order = await json<OrderDetails>(await f.request(`/orders/${search.orders[0]!.orderId}`));
  const checkInput = { orderId: order.orderId, orderItemId: order.items[0]!.orderItemId, requestedQuantity: 1,
    reasonCode: "wrong_size", conditionCode: "opened_unused", storeCreditConsent: true };
  const check = await json<EligibilityResult>(await f.request("/eligibility-checks", "POST", checkInput, "check-flow"), 201);
  expect(await json(await f.request("/eligibility-checks", "POST", checkInput, "check-flow"))).toEqual(check);
  const draft = await json<MessageDraft>(await f.request("/message-drafts", "POST", { caseId: check.caseId, eligibilityCheckId: check.eligibilityCheckId,
    resolutionType: "refund", locale: "en-US" }));
  const proposalInput = { caseId: check.caseId, eligibilityCheckId: check.eligibilityCheckId, resolutionType: "refund",
    customerMessage: { subject: draft.subject, bodyText: draft.bodyText, locale: "en-US" } };
  const proposal = await json<ProposalResult>(await f.request("/rma-proposals", "POST", proposalInput, "proposal-flow"), 201);
  return { order, check, draft, proposal, proposalInput };
}

it("executes the HTTP refund workflow once and returns committed effects", async () => {
  const f = await apiFixture(db); const flow = await returnFlow(f);
  const input = { expectedVersion: flow.proposal.version, confirmation: "approve_and_simulate_completion" };
  const approval = await json<ApprovalResult>(await f.request(`/rma-proposals/${flow.proposal.proposalId}/approve`, "POST", input, "approve-flow"));
  expect(approval).toMatchObject({ proposal: { status: "approved" }, rma: { status: "completed" } });
  expect(approval.executedEffects.map((effect: { entityType: string }) => effect.entityType).sort()).toEqual(["return_label", "simulated_refund"]);
  expect(await json(await f.request(`/rma-proposals/${flow.proposal.proposalId}/approve`, "POST", input, "approve-flow"))).toEqual(approval);
  await json(await f.request(`/cases/${flow.check.caseId}`));
  await json(await f.request(`/cases/${flow.check.caseId}/activity`));
  await json(await f.request(`/order-items/${flow.order.items[0]!.orderItemId}/return-policy?orderId=${flow.order.orderId}`));
  await json(await f.request(`/eligibility-checks/${flow.check.eligibilityCheckId}/compare-resolutions`, "POST", {}));
});

it("denies every human-only mutation to the actual agent channel", async () => {
  const f = await apiFixture(db);
  const agent = await json<{ agentChannelToken: string }>(await f.request("/session/agent-bootstrap"));
  for (const [method, route] of [
    ["POST", "/cases"], ["POST", "/session/reset"], ["POST", "/eligibility-checks/check/reviews"],
    ["POST", "/rma-proposals/prop/approve"], ["POST", "/rma-proposals/prop/reject"], ["POST", "/rma-proposals/prop/replace"],
    ["POST", "/policy-versions"], ["PATCH", "/policy-versions/policy"], ["POST", "/policy-versions/policy/validate"], ["POST", "/policy-versions/policy/activate"],
  ]) {
    expect((await f.request(route!, method!, {}, "forbidden", agent.agentChannelToken)).status, route).toBe(403);
  }
  expect((await f.request("/orders?query=ORD", "GET", undefined, "read", agent.agentChannelToken)).status).toBe(200);
});

it("creates, edits, validates and activates an idempotent policy draft", async () => {
  const f = await apiFixture(db);
  const input = { name: "Demo policy draft", defaultWindowDays: 30, absoluteMaxWindowDays: 60, defaultReturnRequired: true,
    defaultResolutions: ["refund", "store_credit", "exchange"], returnShippingPayer: "merchant", rules: [] };
  const draft = await json<PolicyVersion>(await f.request("/policy-versions", "POST", input, "create-policy"), 201);
  expect(await json(await f.request("/policy-versions", "POST", input, "create-policy"))).toEqual(draft);
  const edited = await json<PolicyVersion>(await f.request(`/policy-versions/${draft.id}`, "PATCH", { ...input, name: "Edited", expectedVersion: 1 }, "edit-policy"));
  expect(edited.version).toBe(2);
  expect(await json(await f.request(`/policy-versions/${draft.id}`, "PATCH", { ...input, name: "Edited", expectedVersion: 1 }, "edit-policy"))).toEqual(edited);
  expect(await json(await f.request(`/policy-versions/${draft.id}/validate`, "POST", {}))).toMatchObject({ valid: true });
  const activated = await json(await f.request(`/policy-versions/${draft.id}/activate`, "POST", { expectedVersion: 2 }, "activate-policy"));
  expect(activated.status).toBe("active");
  expect(await json(await f.request(`/policy-versions/${draft.id}/activate`, "POST", { expectedVersion: 2 }, "activate-policy"))).toEqual(activated);
  await json(await f.request(`/policy-versions/${draft.id}`));
});

it("rejects missing sessions, unknown fields, bad JSON and cross-session entities", async () => {
  const a = await apiFixture(db), b = await apiFixture(db);
  expect((await a.app.request(`${apiOrigin}/api/v1/dashboard`)).status).toBe(401);
  expect((await a.request("/orders?query=ORD&limit=99")).status).toBe(400);
  expect((await a.request("/eligibility-checks", "POST", { actorType: "human" })).status).toBe(400);
  const order = (await json<OrderSearchResult>(await a.request("/orders?query=ORD-1001"))).orders[0]!;
  const foreign = await b.request(`/orders/${order.orderId}`), missing = await b.request("/orders/missing");
  expect(foreign.status).toBe(404); expect(missing.status).toBe(404);
  expect((await foreign.json() as { error: { code: string } }).error.code).toBe((await missing.json() as { error: { code: string } }).error.code);
  expect((await a.app.request(`${apiOrigin}/api/v1/message-drafts`, { method: "POST", headers: a.headers, body: "{" })).status).toBe(400);
});
