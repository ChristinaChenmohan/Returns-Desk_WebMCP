import { z } from "zod";
import { checkEligibilityInput, compareResolutionOptionsInput, draftCustomerMessageInput } from "../../src/shared/contracts/tools";
import { EligibilityService } from "../domain/eligibility-service";
import { EligibilityReviewService, type ReviewEligibility } from "../domain/eligibility-review-service";
import { ResolutionService } from "../domain/resolution-service";
import { MessageService } from "../domain/message-service";
import { caseEffect, command, human, id, keySchema, params, version, type RouteKit } from "./shared";
export function eligibilityRoutes(k: RouteKit) {
  k.write("post", "/eligibility-checks", "eligibility.check", async c => {
    const input = command(c, checkEligibilityInput);
    const status = await k.created(c, "eligibility.check");
    const { inputHash: _hash, correlationId: _correlation, ...result } = await new EligibilityService(k.db, k.clock, k.ids).check(input, c.get("requestContext"));
    return k.ok(c, result, caseEffect(result.caseId, result.caseVersion), status);
  });
  k.write("post", "/eligibility-checks/:checkId/compare-resolutions", "resolutions.compare", async c => k.ok(c,
    await new ResolutionService(k.db, k.clock).compare(command(c, compareResolutionOptionsInput, { eligibilityCheckId: params(c, "checkId") }, false), c.get("requestContext"))));
  k.write("post", "/message-drafts", "messages.draft", async c => k.ok(c,
    await new MessageService(k.db, undefined, k.clock).draft(command(c, draftCustomerMessageInput, {}, false), c.get("requestContext"))));
  k.write("post", "/eligibility-checks/:checkId/reviews", "eligibility.review.human", async c => {
    const input = command(c, z.object({ parentCheckId: id, expectedVersion: version, reviewResult: z.enum(["eligible_exception_approved", "ineligible_exception_denied", "insufficient_evidence"]), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u), note: z.string().max(1000).optional(), idempotencyKey: keySchema }).strict(), { parentCheckId: params(c, "checkId") }) as ReviewEligibility;
    const status = await k.created(c, "eligibility.review");
    const { inputHash: _hash, correlationId: _correlation, ...result } = await new EligibilityReviewService(k.db, k.clock, k.ids).review(input, human(c));
    return k.ok(c, result, caseEffect(result.caseId, result.caseVersion), status);
  });
}
