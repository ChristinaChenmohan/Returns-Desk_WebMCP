import { test, expect } from "@playwright/test";
import { apiProposal, api } from "./helpers";
test("rejection is terminal and replacement preserves the old proposal", async ({ request }) => {
  const f = await apiProposal(request);
  const replacement = await f.call<{ proposalId: string }>(`/rma-proposals/${f.proposal.proposalId}/replace`, "POST", { ...f.input, expectedVersion: 1, customerMessage: { ...f.input.customerMessage, subject: "Corrected" } });
  expect(replacement.response.status()).toBe(201);
  expect((await f.call<{ status: string }>(`/rma-proposals/${f.proposal.proposalId}`)).data.status).toBe("superseded");
  const rejected = await f.call(`/rma-proposals/${replacement.data.proposalId}/reject`, "POST", { expectedVersion: 1, reasonCode: "CUSTOMER_REQUEST" }); expect(rejected.response.ok()).toBe(true);
  const approve = await f.call(`/rma-proposals/${replacement.data.proposalId}/approve`, "POST", { expectedVersion: 2, confirmation: "approve_and_simulate_completion" }); expect(approve.response.status()).toBe(409);
});
test("two tabs cannot execute the same pending proposal twice", async ({ page, context }) => {
  const f = await apiProposal(page.request), second = await context.newPage();
  const other = await api(second.request, f.cookie); const body = { expectedVersion: 1, confirmation: "approve_and_simulate_completion" };
  const responses = await Promise.all([f.call(`/rma-proposals/${f.proposal.proposalId}/approve`, "POST", body), other.call(`/rma-proposals/${f.proposal.proposalId}/approve`, "POST", body)]);
  expect(responses.map(r => r.response.status()).sort()).toEqual([200, 409]);
});

