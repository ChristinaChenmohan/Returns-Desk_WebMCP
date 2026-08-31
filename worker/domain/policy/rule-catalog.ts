import type { EligibilityInput, PolicyRule, PolicyRuleType } from "./types";

const RULE_LAYER: Readonly<Record<PolicyRuleType, number>> = {
  delivery_required: 1,
  quantity_limit: 1,
  return_window: 2,
  final_sale: 2,
  condition_requirement: 2,
  reason_exception: 3,
  manual_review: 3,
  category_window: 4,
  return_shipping: 4,
  return_required: 4,
  store_credit_bonus: 4,
  resolution_allowlist: 5,
};

export function ruleLayer(ruleType: PolicyRuleType): number {
  return RULE_LAYER[ruleType];
}

export function orderRules(rules: readonly PolicyRule[]): PolicyRule[] {
  return rules
    .filter(rule => rule.active)
    .sort((left, right) =>
      ruleLayer(left.ruleType) - ruleLayer(right.ruleType)
      || right.priority - left.priority
      || compareCodePoints(left.id, right.id),
    );
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function matchesRule(rule: PolicyRule, input: EligibilityInput): boolean {
  const conditions = rule.conditions;
  if (conditions.category !== undefined && conditions.category !== input.category) return false;
  if (conditions.finalSale !== undefined && conditions.finalSale !== input.finalSale) return false;
  if (conditions.reasonCodes !== undefined && !conditions.reasonCodes.includes(input.reasonCode)) return false;
  if (conditions.conditionCodes !== undefined && !conditions.conditionCodes.includes(input.conditionCode)) return false;
  if (
    conditions.minRefundableAmountCents !== undefined
    && input.refundableAmountRemainingCents < conditions.minRefundableAmountCents
  ) return false;
  if (
    conditions.maxRefundableAmountCents !== undefined
    && input.refundableAmountRemainingCents > conditions.maxRefundableAmountCents
  ) return false;

  if (
    rule.ruleType === "final_sale"
    && ["damaged", "wrong_item", "not_as_described"].includes(input.reasonCode)
  ) return false;
  return true;
}
