import type { ResolutionType } from "../../src/shared/contracts/common";
import type { CompareResolutionOptionsInput } from "../../src/shared/contracts/tools";
import { EligibilityRepository, type EligibilityCheckRecord } from "../repositories/eligibility-repository";
import { DomainError } from "./errors";
import type { AllowedResolution } from "./policy/types";
import type { Clock } from "./primitives";
import { systemClock } from "./primitives";

interface EligibilityLookup {
  findById(sessionId: string, checkId: string): Promise<EligibilityCheckRecord | null>;
}

export interface ResolutionContext { sessionId: string }

export interface ResolutionComparison {
  eligibilityCheckId: string;
  status: "eligible";
  options: readonly AllowedResolution[];
  recommendedResolution: ResolutionType;
  recommendationReasons: readonly string[];
}

const TYPE_ORDER: Readonly<Record<ResolutionType, number>> = {
  exchange: 0,
  refund: 1,
  store_credit: 2,
};

const FASTEST_ORDER: Readonly<Record<ResolutionType, number>> = {
  refund: 0,
  store_credit: 1,
  exchange: 2,
};

export class ResolutionService {
  private readonly checks: EligibilityLookup;

  constructor(source: D1Database | EligibilityLookup, private readonly clock: Clock = systemClock) {
    this.checks = isDatabase(source) ? new EligibilityRepository(source) : source;
  }

  async compare(
    input: CompareResolutionOptionsInput,
    context: ResolutionContext,
  ): Promise<ResolutionComparison> {
    const check = await this.checks.findById(context.sessionId, input.eligibilityCheckId);
    if (check === null) {
      throw new DomainError("ELIGIBILITY_CHECK_NOT_FOUND", 404, false, "check_return_eligibility");
    }
    if (this.clock.now().getTime() >= new Date(check.expiresAt).getTime()) {
      throw new DomainError("ELIGIBILITY_CHECK_STALE", 409, false, "check_return_eligibility");
    }
    if (check.status !== "eligible" || check.snapshot.decision.status !== "eligible") {
      throw new DomainError("ELIGIBILITY_NOT_ELIGIBLE", 422, false, "review_eligibility");
    }
    const options = check.snapshot.decision.allowedResolutions.map(option => {
      if (!Number.isSafeInteger(option.merchantCostCents) || option.merchantCostCents < 0) {
        throw new DomainError("INVALID_ELIGIBILITY_SNAPSHOT", 500, false);
      }
      return { ...option, recommendationReasons: [...option.recommendationReasons] };
    });
    if (options.length === 0) {
      throw new DomainError("ELIGIBILITY_NOT_ELIGIBLE", 422, false, "check_return_eligibility");
    }
    options.sort((left, right) => compareOptions(left, right, input.preference));
    const recommended = options[0]!;
    return {
      eligibilityCheckId: check.id,
      status: "eligible",
      options,
      recommendedResolution: recommended.type,
      recommendationReasons: [preferenceReason(input.preference), ...recommended.recommendationReasons],
    };
  }
}

function compareOptions(
  left: AllowedResolution,
  right: AllowedResolution,
  preference: CompareResolutionOptionsInput["preference"],
): number {
  let primary = 0;
  if (preference === "merchant_cost") primary = left.merchantCostCents - right.merchantCostCents;
  if (preference === "customer_value") {
    primary = (right.amountCents ?? right.merchantCostCents) - (left.amountCents ?? left.merchantCostCents);
  }
  if (preference === "fastest_resolution") primary = FASTEST_ORDER[left.type] - FASTEST_ORDER[right.type];
  return primary || TYPE_ORDER[left.type] - TYPE_ORDER[right.type];
}

function preferenceReason(preference: CompareResolutionOptionsInput["preference"]): string {
  if (preference === "merchant_cost") return "LOWEST_MERCHANT_COST";
  if (preference === "fastest_resolution") return "FASTEST_RESOLUTION";
  return "HIGHEST_CUSTOMER_VALUE";
}

function isDatabase(value: D1Database | EligibilityLookup): value is D1Database {
  return "prepare" in value && typeof value.prepare === "function";
}
