import type {
  ConditionCode,
  EligibilityStatus,
  ReasonCode,
  ResolutionType,
} from "../../../src/shared/contracts/common";

export type ReturnShippingPayer = "merchant" | "customer";
export type ReviewSource = "engine" | "human";

export type PolicyRuleType =
  | "delivery_required"
  | "quantity_limit"
  | "return_window"
  | "category_window"
  | "final_sale"
  | "condition_requirement"
  | "reason_exception"
  | "resolution_allowlist"
  | "return_shipping"
  | "return_required"
  | "store_credit_bonus"
  | "manual_review";

export interface ReplacementVariantFact {
  id: string;
  sku: string;
  active: boolean;
  inventoryQuantity: number;
  inventoryVersion: number;
  unitPriceCents: number;
}

export interface EligibilityInput {
  sessionId: string;
  caseId: string | null;
  orderId: string;
  orderItemId: string;
  requestedQuantity: number;
  reasonCode: ReasonCode;
  conditionCode: ConditionCode;
  policyVersionId: string;
  orderedAt: string;
  fulfilledAt: string | null;
  deliveredAt: string | null;
  evaluatedAt: string;
  category: string;
  finalSale: boolean;
  allowedReturnConditions: readonly ConditionCode[];
  fulfilledQuantity: number;
  previouslyReturnedQuantity: number;
  currency: string;
  unitPriceCents: number;
  refundableAmountRemainingCents: number;
  replacementVariant: ReplacementVariantFact | null;
  storeCreditConsent: boolean;
  reviewSource: ReviewSource;
  humanReviewOutcome?: string;
}

export interface PolicyRuleConditions {
  category?: string;
  finalSale?: boolean;
  reasonCodes?: readonly ReasonCode[];
  conditionCodes?: readonly ConditionCode[];
  minRefundableAmountCents?: number;
  maxRefundableAmountCents?: number;
}

export interface PolicyRuleOutcome {
  eligibility?: EligibilityStatus;
  reasonCode?: string;
  returnWindowDays?: number;
  allowedResolutions?: readonly ResolutionType[];
  returnRequired?: boolean;
  returnShippingPayer?: ReturnShippingPayer;
  storeCreditBonusBps?: number;
  storeCreditBonusCents?: number;
}

export interface PolicyRule {
  id: string;
  ruleType: PolicyRuleType;
  priority: number;
  conditions: PolicyRuleConditions;
  outcome: PolicyRuleOutcome;
  explanation: string;
  active: boolean;
}

export interface PolicyDefinition {
  id: string;
  name: string;
  versionNumber: number;
  defaultWindowDays: number;
  absoluteMaxWindowDays: number;
  defaultReturnRequired: boolean;
  defaultResolutions: readonly ResolutionType[];
  returnShippingPayer: ReturnShippingPayer;
  eligibilityTtlMinutes: number;
  rules: readonly PolicyRule[];
}

export interface MatchedPolicyRule {
  ruleId: string;
  layer: number;
  priority: number;
  effect: "applied" | "overridden" | "terminal";
  explanation: string;
}

export interface PolicyConflictEvidence {
  layer: number;
  priority: number;
  field: string;
  ruleIds: readonly string[];
  values: readonly unknown[];
}

export interface AllowedResolution {
  type: ResolutionType;
  customerOutcome: string;
  merchantCostCents: number;
  amountCents: number | null;
  currency: string;
  returnRequired: boolean;
  customerConsentRequired: boolean;
  replacementVariantId: string | null;
  replacementSku: string | null;
  inventoryQuantity: number | null;
  inventoryVersion: number | null;
  recommendationReasons: readonly string[];
}

export interface EligibilityDecision {
  status: EligibilityStatus;
  policyVersionId: string;
  policyName: string;
  requestedQuantity: number;
  remainingReturnableQuantity: number;
  allowedResolutions: readonly AllowedResolution[];
  returnRequired: boolean;
  returnShippingPayer: ReturnShippingPayer;
  reasonCodes: readonly string[];
  matchedRules: readonly MatchedPolicyRule[];
  missingInformation: readonly string[];
  windowEndsAt: string | null;
  elapsedDays: number | null;
  expiresAt: string;
  inputHash: string;
  conflictEvidence: PolicyConflictEvidence | null;
  proposalSubmissionAllowed: boolean;
}

export interface ResolutionSettings {
  allowedResolutions: readonly ResolutionType[];
  returnRequired: boolean;
  storeCreditBonusBps: number;
  storeCreditBonusCents: number;
}
