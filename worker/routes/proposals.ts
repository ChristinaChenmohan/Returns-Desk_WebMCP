import { z } from "zod";
import { submitProposalInput } from "../../src/shared/contracts/tools";
import { ProposalService, type RejectProposal, type ReplaceProposal } from "../domain/proposal-service";
import { ApprovalService } from "../domain/approval-service";
import { DomainError } from "../domain/errors";
import { caseEffect, command, human, id, keySchema, params, version, type RouteKit } from "./shared";
export function proposalRoutes(k: RouteKit) {
  const proposals = new ProposalService(k.db, k.clock, k.ids);
  k.get("/rma-proposals/:proposalId", "proposals.read", async c => k.ok(c, await proposals.read(params(c, "proposalId"), c.get("requestContext"))));
  k.write("post", "/rma-proposals", "proposal.submit", async c => {
    const input = command(c, submitProposalInput); const status = await k.created(c, "proposal.submit");
    const result = await proposals.submit(input, c.get("requestContext"));
    return k.ok(c, result, caseEffect(result.caseId, result.caseSync.caseVersion), status);
  });
  k.write("post", "/rma-proposals/:proposalId/approve", "proposal.approve.human", async c => {
    const input = command(c, z.object({ proposalId: id, expectedVersion: version, confirmation: z.literal("approve_and_simulate_completion"), idempotencyKey: keySchema }).strict(), { proposalId: params(c, "proposalId") });
    const { effects, ...result } = await new ApprovalService(k.db, k.clock, k.ids).approve(input, human(c));
    if (result.proposal.status === "invalidated") throw new DomainError("PROPOSAL_INVALIDATED", 409, false, result.proposal.invalidatedReasonCode ?? "rerun_eligibility", "invalidated");
    return k.ok(c, result, effects.map(effect => ({ ...effect, entityType: effect.entityType === "case" ? "return_case" : effect.entityType })));
  });
  k.write("post", "/rma-proposals/:proposalId/reject", "proposal.reject.human", async c => {
    const input = command(c, z.object({ proposalId: id, expectedVersion: version, reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), note: z.string().max(1000).optional(), idempotencyKey: keySchema }).strict(), { proposalId: params(c, "proposalId") }) as RejectProposal;
    const result = await proposals.reject(input, human(c));
    return k.ok(c, result, caseEffect(result.caseId, result.caseSync.caseVersion));
  });
  k.write("post", "/rma-proposals/:proposalId/replace", "proposal.replace.human", async c => {
    const input = command(c, submitProposalInput.extend({ proposalId: id, expectedVersion: version, note: z.string().max(1000).optional() }), { proposalId: params(c, "proposalId") }) as ReplaceProposal;
    const status = await k.created(c, "proposal.replace");
    const result = await proposals.replace(input, human(c));
    return k.ok(c, result, caseEffect(result.caseId, result.caseSync.caseVersion), status);
  });
}
