import { test, expect } from "@playwright/test";
import { apiProposal, api } from "./helpers";
test("isolates cases and blocks a real agent credential from approving", async ({ request, playwright, baseURL }) => {
  const f = await apiProposal(request); const other = await playwright.request.newContext({ baseURL: baseURL! });
  try { const b = await api(other); expect((await b.call(`/cases/${f.check.caseId}`)).response.status()).toBe(404); } finally { await other.dispose(); }
  const agent = await f.call<{ agentChannelToken: string }>("/session/agent-bootstrap");
  const response = await request.post(`/api/v1/rma-proposals/${f.proposal.proposalId}/approve`, { headers: { Cookie: f.cookie, "X-Channel-Token": agent.data.agentChannelToken, "X-CSRF-Token": f.auth.csrfToken, Origin: baseURL! }, data: { expectedSeedVersion: f.auth.seedVersion, expectedVersion: 1, confirmation: "approve_and_simulate_completion" } });
  expect(response.status()).toBe(403);
});


