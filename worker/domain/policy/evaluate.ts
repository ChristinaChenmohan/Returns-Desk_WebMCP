import { hashEligibilityInput, hashInvalidEligibilityInput } from "./hash-input";
import { generateResolutions } from "./resolutions";
import { matchesRule, orderRules, ruleLayer } from "./rule-catalog";
import type {
  EligibilityDecision,
  EligibilityInput,
  MatchedPolicyRule,
  PolicyConflictEvidence,
  PolicyDefinition,
  PolicyRule,
  PolicyRuleOutcome,
  ResolutionSettings,
  ReturnShippingPayer,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const HARD_PRIORITY = 1_000_000_000;
const ADJUSTMENT_FIELDS = [
  "returnWindowDays", "allowedResolutions", "returnRequired",
  "returnShippingPayer", "storeCreditBonusBps", "storeCreditBonusCents",
] as const satisfies readonly (keyof PolicyRuleOutcome)[];

interface MutablePolicyState {
  returnWindowDays: number;
  returnRequired: boolean;
  returnShippingPayer: ReturnShippingPayer;
  allowedResolutions: ResolutionSettings["allowedResolutions"];
  storeCreditBonusBps: number;
  storeCreditBonusCents: number;
}

interface ValidInstants {
  orderedAt: number;
  fulfilledAt: number | null;
  deliveredAt: number | null;
  evaluatedAt: number;
}

interface TerminalCandidate {
  id: string;
  layer: number;
  priority: number;
  status: "eligible" | "ineligible" | "needs_review";
  reasonCode: string;
  conflictEvidence: PolicyConflictEvidence | null;
}

export function evaluateEligibility(
  input: EligibilityInput,
  policy: PolicyDefinition,
): EligibilityDecision {
  const instants = validateInstants(input);
  if (instants === null) return invalidInputDecision(input, policy);

  const inputHash = hashEligibilityInput(input, policy);
  const expiresAt = new Date(
    instants.evaluatedAt + policy.eligibilityTtlMinutes * 60_000,
  ).toISOString();
  const remaining = input.fulfilledQuantity - input.previouslyReturnedQuantity;
  const common = {
    policyVersionId: policy.id,
    policyName: policy.name,
    requestedQuantity: input.requestedQuantity,
    remainingReturnableQuantity: Math.max(0, remaining),
    returnRequired: policy.defaultReturnRequired,
    returnShippingPayer: policy.returnShippingPayer,
    expiresAt,
    inputHash,
  };
  const matching = orderRules(policy.rules).filter(rule => matchesRule(rule, input));
  const evidence: MatchedPolicyRule[] = matching.map(rule => ({
    ruleId: rule.id,
    layer: ruleLayer(rule.ruleType),
    priority: rule.priority,
    effect: rule.outcome.eligibility === undefined ? "applied" : "terminal",
    explanation: rule.explanation,
  }));
  const state: MutablePolicyState = {
    returnWindowDays: policy.defaultWindowDays,
    returnRequired: policy.defaultReturnRequired,
    returnShippingPayer: policy.returnShippingPayer,
    allowedResolutions: [...new Set(policy.defaultResolutions)],
    storeCreditBonusBps: 0,
    storeCreditBonusCents: 0,
  };
  const adjustmentConflicts = findAdjustmentConflicts(matching);
  applyAdjustments(state, matching, evidence, adjustmentConflicts);
  state.returnWindowDays = Math.min(state.returnWindowDays, policy.absoluteMaxWindowDays);

  const deliveredDay = instants.deliveredAt === null ? null : utcDayStart(instants.deliveredAt);
  const evaluatedDay = utcDayStart(instants.evaluatedAt);
  const elapsedDays = deliveredDay === null
    ? null
    : Math.floor((evaluatedDay - deliveredDay) / DAY_MS);
  const windowEndsAtMs = deliveredDay === null
    ? null
    : deliveredDay + state.returnWindowDays * DAY_MS;
  const windowEndsAt = windowEndsAtMs === null ? null : new Date(windowEndsAtMs).toISOString();
  const candidates = buildTerminalCandidates(
    input,
    instants,
    remaining,
    matching,
    adjustmentConflicts,
    windowEndsAtMs,
  );
  const selected = selectTerminalCandidate(candidates);
  if (selected !== null && selected.status !== "eligible") {
    return {
      ...terminalDecision({
        ...common,
        returnRequired: state.returnRequired,
        returnShippingPayer: state.returnShippingPayer,
      }, selected.reasonCode, selected.status),
      elapsedDays,
      windowEndsAt,
      matchedRules: evidence,
      conflictEvidence: selected.conflictEvidence,
    };
  }

  const resolutions = generateResolutions(input, state);
  if (resolutions.options.length === 0) {
    return {
      ...terminalDecision({
        ...common,
        returnRequired: state.returnRequired,
        returnShippingPayer: state.returnShippingPayer,
      }, resolutions.reasonCodes[0] ?? "NO_ALLOWED_RESOLUTION", "ineligible"),
      elapsedDays,
      windowEndsAt,
      matchedRules: evidence,
      reasonCodes: resolutions.reasonCodes.length === 0
        ? ["NO_ALLOWED_RESOLUTION"]
        : resolutions.reasonCodes,
      missingInformation: resolutions.missingInformation,
    };
  }
  return {
    ...common,
    status: "eligible",
    allowedResolutions: resolutions.options,
    returnRequired: state.returnRequired,
    returnShippingPayer: state.returnShippingPayer,
    reasonCodes: [selected?.reasonCode ?? "WITHIN_RETURN_WINDOW", ...resolutions.reasonCodes],
    matchedRules: evidence,
    missingInformation: resolutions.missingInformation,
    windowEndsAt,
    elapsedDays,
    conflictEvidence: null,
    proposalSubmissionAllowed: true,
  };
}

function buildTerminalCandidates(
  input: EligibilityInput,
  instants: ValidInstants,
  remaining: number,
  matching: readonly PolicyRule[],
  adjustmentConflicts: readonly PolicyConflictEvidence[],
  windowEndsAtMs: number | null,
): TerminalCandidate[] {
  const candidates = matching.flatMap<TerminalCandidate>(rule => {
    const status = rule.outcome.eligibility;
    if (status === undefined) return [];
    return [{
      id: rule.id,
      layer: ruleLayer(rule.ruleType),
      priority: rule.priority,
      status,
      reasonCode: rule.outcome.reasonCode ?? "MANUAL_REVIEW_REQUIRED",
      conflictEvidence: null,
    }];
  });
  const add = (
    id: string,
    layer: number,
    priority: number,
    status: TerminalCandidate["status"],
    reasonCode: string,
    conflictEvidence: PolicyConflictEvidence | null = null,
  ): void => {
    candidates.push({ id, layer, priority, status, reasonCode, conflictEvidence });
  };

  if (!Number.isInteger(input.requestedQuantity) || input.requestedQuantity <= 0) {
    add("builtin.invalid_quantity", 1, HARD_PRIORITY + 4, "ineligible", "INVALID_ELIGIBILITY_INPUT");
  }
  if (
    !Number.isInteger(input.fulfilledQuantity)
    || !Number.isInteger(input.previouslyReturnedQuantity)
    || input.fulfilledQuantity < 0
    || input.previouslyReturnedQuantity < 0
    || input.previouslyReturnedQuantity > input.fulfilledQuantity
    || !Number.isSafeInteger(input.unitPriceCents)
    || !Number.isSafeInteger(input.refundableAmountRemainingCents)
    || input.unitPriceCents < 0
    || input.refundableAmountRemainingCents < 0
  ) add("builtin.invalid_facts", 1, HARD_PRIORITY + 3, "ineligible", "INVALID_ELIGIBILITY_INPUT");
  if (instants.deliveredAt === null) {
    add("builtin.delivery_required", 1, HARD_PRIORITY + 2, "ineligible", "ORDER_NOT_DELIVERED");
  } else if (instants.evaluatedAt < instants.deliveredAt) {
    add("builtin.delivery_after_evaluation", 1, HARD_PRIORITY + 3, "ineligible", "INVALID_ELIGIBILITY_INPUT");
  }
  if (remaining <= 0 || input.requestedQuantity > remaining) {
    add("builtin.quantity_limit", 1, HARD_PRIORITY + 1, "ineligible", "NO_RETURNABLE_QUANTITY");
  }
  if (input.reasonCode === "changed_mind" && input.conditionCode === "damaged") {
    add("builtin.condition_reason_conflict", 1, HARD_PRIORITY, "needs_review", "CONDITION_REASON_CONFLICT");
  }
  if (!input.allowedReturnConditions.includes(input.conditionCode)) {
    add("builtin.condition_requirement", 2, HARD_PRIORITY + 2, "ineligible", "CONDITION_NOT_ALLOWED");
  }
  if (
    windowEndsAtMs !== null
    && instants.evaluatedAt >= windowEndsAtMs
  ) add("builtin.return_window", 2, HARD_PRIORITY + 1, "ineligible", "RETURN_WINDOW_CLOSED");
  if (input.finalSale && !isFinalSaleException(input)) {
    add("builtin.final_sale", 2, HARD_PRIORITY, "ineligible", "FINAL_SALE_RESTRICTED");
  }
  if (input.finalSale && isFinalSaleException(input)) {
    add("builtin.final_sale_exception", 3, 0, "needs_review", "MANUAL_REVIEW_REQUIRED");
  }
  for (const adjustmentConflict of adjustmentConflicts) {
    add(
      `builtin.policy_conflict.${adjustmentConflict.field}`,
      adjustmentConflict.layer,
      adjustmentConflict.priority,
      "needs_review",
      "POLICY_RULE_CONFLICT",
      adjustmentConflict,
    );
  }
  return candidates;
}

function selectTerminalCandidate(candidates: readonly TerminalCandidate[]): TerminalCandidate | null {
  const ordered = [...candidates].sort((left, right) =>
    left.layer - right.layer
    || right.priority - left.priority
    || compareStableId(left.id, right.id),
  );
  const first = ordered[0];
  if (first === undefined) return null;
  const peers = ordered.filter(candidate =>
    candidate.layer === first.layer && candidate.priority === first.priority,
  );
  const explicitConflict = peers.find(candidate => candidate.conflictEvidence !== null);
  if (explicitConflict !== undefined) return explicitConflict;
  const statuses = new Set(peers.map(candidate => candidate.status));
  if (statuses.size > 1) return terminalConflict(peers, "eligibility", peers.map(item => item.status));
  const reasons = new Set(peers.map(candidate => candidate.reasonCode));
  if (reasons.size > 1) return terminalConflict(peers, "reasonCode", peers.map(item => item.reasonCode));
  return first;
}

function terminalConflict(
  peers: readonly TerminalCandidate[],
  field: "eligibility" | "reasonCode",
  values: readonly string[],
): TerminalCandidate {
  const first = peers[0];
  if (first === undefined) throw new Error("Terminal conflict requires candidates.");
  return {
    id: "builtin.policy_rule_conflict",
    layer: first.layer,
    priority: first.priority,
    status: "needs_review",
    reasonCode: "POLICY_RULE_CONFLICT",
    conflictEvidence: {
      layer: first.layer,
      priority: first.priority,
      field,
      ruleIds: peers.map(candidate => candidate.id),
      values,
    },
  };
}

function findAdjustmentConflicts(rules: readonly PolicyRule[]): PolicyConflictEvidence[] {
  const conflicts: PolicyConflictEvidence[] = [];
  for (let start = 0; start < rules.length;) {
    const first = rules[start];
    if (first === undefined) break;
    const layer = ruleLayer(first.ruleType);
    let end = start + 1;
    while (
      end < rules.length
      && rules[end]?.priority === first.priority
      && ruleLayer(rules[end]?.ruleType ?? first.ruleType) === layer
    ) end += 1;
    const group = rules.slice(start, end);
    for (const field of ADJUSTMENT_FIELDS) {
      const assignments = group
        .filter(rule => rule.outcome[field] !== undefined)
        .map(rule => ({ ruleId: rule.id, value: normalizedOutcomeValue(field, rule.outcome[field]) }));
      if (new Set(assignments.map(item => JSON.stringify(item.value))).size > 1) {
        conflicts.push({
          layer,
          priority: first.priority,
          field,
          ruleIds: assignments.map(item => item.ruleId),
          values: assignments.map(item => item.value),
        });
      }
    }
    start = end;
  }
  return conflicts;
}

function applyAdjustments(
  state: MutablePolicyState,
  rules: readonly PolicyRule[],
  evidence: MatchedPolicyRule[],
  conflicts: readonly PolicyConflictEvidence[],
): void {
  const assigned = new Set<keyof MutablePolicyState>();
  const blockedFields = new Set(conflicts.map(conflict => conflict.field));
  for (const rule of rules) {
    const updates: Partial<MutablePolicyState> = {};
    const outcome = rule.outcome;
    if (outcome.returnWindowDays !== undefined) updates.returnWindowDays = outcome.returnWindowDays;
    if (outcome.returnRequired !== undefined) updates.returnRequired = outcome.returnRequired;
    if (outcome.returnShippingPayer !== undefined) updates.returnShippingPayer = outcome.returnShippingPayer;
    if (outcome.allowedResolutions !== undefined) updates.allowedResolutions = [...new Set(outcome.allowedResolutions)];
    if (outcome.storeCreditBonusBps !== undefined) updates.storeCreditBonusBps = outcome.storeCreditBonusBps;
    if (outcome.storeCreditBonusCents !== undefined) updates.storeCreditBonusCents = outcome.storeCreditBonusCents;
    let applied = false;
    for (const key of Object.keys(updates) as (keyof MutablePolicyState)[]) {
      if (blockedFields.has(key)) {
        const match = evidence.find(item => item.ruleId === rule.id);
        if (match !== undefined) match.effect = "overridden";
        continue;
      }
      if (assigned.has(key)) {
        const match = evidence.find(item => item.ruleId === rule.id);
        if (match !== undefined) match.effect = "overridden";
        continue;
      }
      assignState(state, key, updates[key]);
      assigned.add(key);
      applied = true;
    }
    if (!applied && Object.keys(updates).length > 0) {
      const match = evidence.find(item => item.ruleId === rule.id);
      if (match !== undefined) match.effect = "overridden";
    }
  }
}

function assignState<K extends keyof MutablePolicyState>(
  state: MutablePolicyState,
  key: K,
  value: MutablePolicyState[K] | undefined,
): void {
  if (value !== undefined) state[key] = value;
}

function normalizedOutcomeValue(
  field: keyof PolicyRuleOutcome,
  value: PolicyRuleOutcome[keyof PolicyRuleOutcome],
): unknown {
  return field === "allowedResolutions" && Array.isArray(value)
    ? [...value as unknown[]].sort((left, right) => compareStableId(String(left), String(right)))
    : value;
}

function validateInstants(input: EligibilityInput): ValidInstants | null {
  const orderedAt = parseInstant(input.orderedAt);
  const fulfilledAt = parseOptionalInstant(input.fulfilledAt);
  const deliveredAt = parseOptionalInstant(input.deliveredAt);
  const evaluatedAt = parseInstant(input.evaluatedAt);
  if (
    orderedAt === null
    || fulfilledAt === undefined
    || deliveredAt === undefined
    || evaluatedAt === null
  ) return null;
  return { orderedAt, fulfilledAt, deliveredAt, evaluatedAt };
}

function parseInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return new Date(parsed).toISOString() === canonical ? parsed : null;
}

function parseOptionalInstant(value: string | null): number | null | undefined {
  if (value === null) return null;
  return parseInstant(value) ?? undefined;
}

function utcDayStart(instant: number): number {
  const value = new Date(instant);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function invalidInputDecision(
  input: EligibilityInput,
  policy: PolicyDefinition,
): EligibilityDecision {
  return terminalDecision({
    policyVersionId: policy.id,
    policyName: policy.name,
    requestedQuantity: input.requestedQuantity,
    remainingReturnableQuantity: Math.max(
      0,
      input.fulfilledQuantity - input.previouslyReturnedQuantity,
    ),
    returnRequired: policy.defaultReturnRequired,
    returnShippingPayer: policy.returnShippingPayer,
    expiresAt: "1970-01-01T00:00:00.000Z",
    inputHash: hashInvalidEligibilityInput(input, policy),
  }, "INVALID_ELIGIBILITY_INPUT", "ineligible");
}

function terminalDecision(
  common: {
    policyVersionId: string;
    policyName: string;
    requestedQuantity: number;
    remainingReturnableQuantity: number;
    returnRequired: boolean;
    returnShippingPayer: ReturnShippingPayer;
    expiresAt: string;
    inputHash: string;
  },
  reasonCode: string,
  status: "ineligible" | "needs_review",
): EligibilityDecision {
  return {
    ...common,
    status,
    allowedResolutions: [],
    reasonCodes: [reasonCode],
    matchedRules: [],
    missingInformation: [],
    windowEndsAt: null,
    elapsedDays: null,
    conflictEvidence: null,
    proposalSubmissionAllowed: false,
  };
}

function isFinalSaleException(input: EligibilityInput): boolean {
  return input.reasonCode === "damaged"
    || input.reasonCode === "wrong_item"
    || input.reasonCode === "not_as_described";
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
