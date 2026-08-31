import { test, expect } from "@playwright/test";
import { apiProposal, api } from "./helpers";
test("same-key approval retries return identical facts and reset rejects old credentials", async ({ request }) => {
  const f = await apiProposal(request); const input = { expectedVersion: 1, confirmation: "approve_and_simulate_completion" };
  const first = await f.call(`/rma-proposals/${f.proposal.proposalId}/approve`, "POST", input, "same-key");
  const retry = await f.call(`/rma-proposals/${f.proposal.proposalId}/approve`, "POST", input, "same-key"); expect(retry.data).toEqual(first.data);
  expect((await f.call("/session/reset", "POST", { confirmation: "reset_current_demo_session" })).response.ok()).toBe(true);
  expect((await f.call(`/cases/${f.check.caseId}`)).response.status()).toBe(403);
  const fresh = await api(request, f.cookie); expect(fresh.auth.seedVersion).toBe(2); expect((await fresh.call(`/cases/${f.check.caseId}`)).response.status()).toBe(404);
});

