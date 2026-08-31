import { z } from "zod";

import {
  conditionCode,
  eligibilityStatus,
  reasonCode,
  resolutionType,
} from "../../src/shared/contracts/common";
import type { ResolutionType } from "../../src/shared/contracts/common";
import { DomainError } from "../domain/errors";
import type {
  PolicyDefinition,
  PolicyRule,
  PolicyRuleConditions,
  PolicyRuleOutcome,
  PolicyRuleType,
  ReturnShippingPayer,
} from "../domain/policy/types";

interface PolicyRow {
  id: string;
  name: string;
  version_number: number;
  default_window_days: number;
  absolute_max_window_days: number;
  default_return_required: number;
  default_resolutions_json: string;
  return_shipping_payer: ReturnShippingPayer;
}

interface RuleRow {
  id: string;
  rule_type: string;
  priority: number;
  conditions_json: string;
  outcome_json: string;
  explanation_template: string;
  active: number;
}

const RESOLUTION_TYPES = new Set<string>(["exchange", "refund", "store_credit"]);
const reasonResultCode = z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/);
const terminalIneligible = z.object({
  eligibility: z.literal("ineligible"),
  reasonCode: reasonResultCode,
}).strict();
const terminalException = z.object({
  eligibility: eligibilityStatus,
  reasonCode: reasonResultCode,
}).strict();
const selectorConditions = {
  category: z.string().min(1).max(120).optional(),
  finalSale: z.boolean().optional(),
  reasonCodes: z.array(reasonCode).min(1).optional(),
  conditionCodes: z.array(conditionCode).min(1).optional(),
};
const amountConditions = {
  minRefundableAmountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  maxRefundableAmountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};
const ruleEnvelope = {
  conditions: z.unknown(),
  outcome: z.unknown(),
};
const ruleSchemas = {
  delivery_required: z.object({
    ...ruleEnvelope,
    conditions: z.object({}).strict(),
    outcome: terminalIneligible,
  }).strict(),
  quantity_limit: z.object({
    ...ruleEnvelope,
    conditions: z.object({}).strict(),
    outcome: terminalIneligible,
  }).strict(),
  return_window: z.object({
    ...ruleEnvelope,
    conditions: z.object({}).strict(),
    outcome: z.union([
      terminalIneligible,
      z.object({ returnWindowDays: z.number().int().nonnegative().max(3650) }).strict(),
    ]),
  }).strict(),
  category_window: z.object({
    ...ruleEnvelope,
    conditions: z.object({ category: z.string().min(1).max(120) }).strict(),
    outcome: z.object({ returnWindowDays: z.number().int().nonnegative().max(3650) }).strict(),
  }).strict(),
  final_sale: z.object({
    ...ruleEnvelope,
    conditions: z.object({
      finalSale: z.literal(true),
      reasonCodes: z.array(reasonCode).min(1).optional(),
    }).strict(),
    outcome: terminalIneligible,
  }).strict(),
  condition_requirement: z.object({
    ...ruleEnvelope,
    conditions: z.object({ conditionCodes: z.array(conditionCode).min(1) }).strict(),
    outcome: terminalException,
  }).strict(),
  reason_exception: z.object({
    ...ruleEnvelope,
    conditions: z.object({
      reasonCodes: z.array(reasonCode).min(1),
      finalSale: z.boolean().optional(),
    }).strict(),
    outcome: terminalException,
  }).strict(),
  resolution_allowlist: z.object({
    ...ruleEnvelope,
    conditions: z.object(selectorConditions).strict(),
    outcome: z.object({ allowedResolutions: z.array(resolutionType).min(1) }).strict(),
  }).strict(),
  return_shipping: z.object({
    ...ruleEnvelope,
    conditions: z.object(selectorConditions).strict(),
    outcome: z.object({ returnShippingPayer: z.enum(["merchant", "customer"]) }).strict(),
  }).strict(),
  return_required: z.object({
    ...ruleEnvelope,
    conditions: z.object({ ...selectorConditions, ...amountConditions }).strict(),
    outcome: z.object({ returnRequired: z.boolean() }).strict(),
  }).strict(),
  store_credit_bonus: z.object({
    ...ruleEnvelope,
    conditions: z.object({ ...selectorConditions, ...amountConditions }).strict(),
    outcome: z.object({
      storeCreditBonusBps: z.number().int().nonnegative().max(10_000).optional(),
      storeCreditBonusCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    }).strict().refine(
      outcome => outcome.storeCreditBonusBps !== undefined
        || outcome.storeCreditBonusCents !== undefined,
      "A store-credit bonus outcome is required.",
    ),
  }).strict(),
  manual_review: z.object({
    ...ruleEnvelope,
    conditions: z.object(selectorConditions).strict(),
    outcome: z.object({
      eligibility: z.literal("needs_review"),
      reasonCode: reasonResultCode,
    }).strict(),
  }).strict(),
} satisfies Readonly<Record<PolicyRuleType, z.ZodType>>;

export class PolicyRepository {
  constructor(private readonly db: D1Database) {}

  async findById(sessionId: string, policyVersionId: string): Promise<PolicyDefinition | null> {
    const row = await this.db.prepare(
      `SELECT id, name, version_number, default_window_days,
              absolute_max_window_days, default_return_required,
              default_resolutions_json, return_shipping_payer
         FROM policy_versions
        WHERE session_id = ? AND id = ?`,
    ).bind(sessionId, policyVersionId).first<PolicyRow>();
    if (row === null) return null;
    const ruleRows = await this.db.prepare(
      `SELECT id, rule_type, priority, conditions_json, outcome_json,
              explanation_template, active
         FROM policy_rules
        WHERE session_id = ? AND policy_version_id = ?
        ORDER BY id`,
    ).bind(sessionId, policyVersionId).all<RuleRow>();
    return {
      id: row.id,
      name: row.name,
      versionNumber: row.version_number,
      defaultWindowDays: row.default_window_days,
      absoluteMaxWindowDays: row.absolute_max_window_days,
      defaultReturnRequired: row.default_return_required === 1,
      defaultResolutions: parseResolutions(row.default_resolutions_json),
      returnShippingPayer: row.return_shipping_payer,
      eligibilityTtlMinutes: 15,
      rules: ruleRows.results.map(toRule),
    };
  }
}

function toRule(row: RuleRow): PolicyRule {
  if (!isRuleType(row.rule_type)) throw invalidPolicy();
  if (!Number.isSafeInteger(row.priority) || Math.abs(row.priority) > 1_000_000) {
    throw invalidPolicy();
  }
  const payload = {
    conditions: parseJson(row.conditions_json),
    outcome: parseJson(row.outcome_json),
  };
  const parsed = ruleSchemas[row.rule_type].safeParse(payload);
  if (!parsed.success) throw invalidPolicy();
  return {
    id: row.id,
    ruleType: row.rule_type,
    priority: row.priority,
    conditions: removeUndefined(parsed.data.conditions) as PolicyRuleConditions,
    outcome: removeUndefined(parsed.data.outcome) as PolicyRuleOutcome,
    explanation: row.explanation_template,
    active: row.active === 1,
  };
}

function parseResolutions(value: string): readonly ResolutionType[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string" && RESOLUTION_TYPES.has(item))) {
    throw invalidPolicy();
  }
  return parsed as ResolutionType[];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidPolicy();
  }
}

function isRuleType(value: string): value is PolicyRuleType {
  return Object.hasOwn(ruleSchemas, value);
}

function removeUndefined(value: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
}

function invalidPolicy(): DomainError {
  return new DomainError("INVALID_POLICY_VERSION", 500, false);
}
