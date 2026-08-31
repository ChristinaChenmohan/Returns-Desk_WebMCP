import type { ResolutionType } from "../../src/shared/contracts/common";
import type { RequestContext } from "../http/context";
import {
  PolicyRepository,
  validatePolicyHeaderDefinition,
  validatePolicyRuleDraft,
  type PolicyRuleDraftInput,
} from "../repositories/policy-repository";
import { DomainError } from "./errors";
import { normalizePolicyOutcomeValue } from "./policy/evaluate";
import { canonicalJson } from "./policy/hash-input";
import { ruleLayer } from "./policy/rule-catalog";
import type { PolicyRule, PolicyRuleType, ReturnShippingPayer } from "./policy/types";
import type { Clock, IdGenerator } from "./primitives";
import { cryptoIds, systemClock } from "./primitives";

export type HumanContext = Omit<RequestContext, "actor"> & {
  actor: { type: "human"; id: string };
};

export interface UpdatePolicyDraft {
  id: string;
  expectedVersion: number;
  name: string;
  defaultWindowDays: number;
  absoluteMaxWindowDays: number;
  defaultReturnRequired: boolean;
  defaultResolutions: readonly ResolutionType[];
  returnShippingPayer: ReturnShippingPayer;
  rules: readonly (Omit<PolicyRuleDraftInput, "ruleType"> & { ruleType: PolicyRuleType })[];
}

export interface ActivatePolicy {
  id: string;
  expectedVersion: number;
}

export interface PolicyVersion {
  id: string;
  versionNumber: number;
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  defaultWindowDays: number;
  absoluteMaxWindowDays: number;
  defaultReturnRequired: boolean;
  defaultResolutions: readonly ResolutionType[];
  returnShippingPayer: ReturnShippingPayer;
  status: "draft" | "active" | "retired";
  version: number;
  rules: readonly PolicyRule[];
}

export interface PolicyConflict {
  layer: number;
  priority: number;
  field: string;
  ruleIds: readonly string[];
}

export interface PolicyValidation {
  valid: boolean;
  conflicts: readonly PolicyConflict[];
}

interface PolicyAdminRow {
  id: string;
  version_number: number;
  name: string;
  effective_from: string;
  effective_to: string | null;
  default_window_days: number;
  absolute_max_window_days: number;
  default_return_required: number;
  default_resolutions_json: string;
  return_shipping_payer: ReturnShippingPayer;
  status: PolicyVersion["status"];
  version: number;
}

export class PolicyAdminService {
  private readonly policies: PolicyRepository;

  constructor(
    private readonly db: D1Database,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = cryptoIds,
  ) {
    this.policies = new PolicyRepository(db);
  }

  async updateDraft(command: UpdatePolicyDraft, context: HumanContext): Promise<PolicyVersion> {
    assertHuman(context);
    validatePolicyHeader(command);
    const rules = validateRules(command.rules);
    const conflicts = findPolicyConflicts(rules);
    if (conflicts.length > 0) {
      throw new DomainError("POLICY_RULE_CONFLICT", 422, false, "resolve_policy_conflicts");
    }
    const auditId = this.ids.next("audit");
    const now = this.clock.now().toISOString();
    const metadata = JSON.stringify({ version: command.expectedVersion + 1 });
    const statements: D1PreparedStatement[] = [
      this.db.prepare(
        `UPDATE policy_versions
            SET name = ?, default_window_days = ?, absolute_max_window_days = ?,
                default_return_required = ?, default_resolutions_json = ?,
                return_shipping_payer = ?, version = version + 1
          WHERE session_id = ? AND id = ? AND status = 'draft' AND version = ?
            AND EXISTS (
              SELECT 1 FROM demo_sessions
               WHERE id = ? AND seed_version = ?
            )`,
      ).bind(
        command.name.trim(), command.defaultWindowDays, command.absoluteMaxWindowDays,
        command.defaultReturnRequired ? 1 : 0, JSON.stringify(command.defaultResolutions),
        command.returnShippingPayer, context.sessionId, command.id, command.expectedVersion,
        context.sessionId, context.seedVersion,
      ),
      this.db.prepare(
        `INSERT INTO audit_events
          (id, session_id, case_id, actor_type, actor_id, event_type,
           entity_type, entity_id, summary, metadata_json, created_at)
         SELECT ?, ?, NULL, 'human', ?, 'policy.updated', 'policy_version', ?,
                'Updated a policy draft.', ?, ?
           FROM policy_versions
          WHERE session_id = ? AND id = ? AND status = 'draft' AND version = ?
            AND changes() = 1`,
      ).bind(
        auditId, context.sessionId, context.actor.id, command.id, metadata, now,
        context.sessionId, command.id, command.expectedVersion + 1,
      ),
      this.db.prepare(
        `DELETE FROM policy_rules
          WHERE session_id = ? AND policy_version_id = ?
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE session_id = ? AND id = ? AND entity_id = ?
            )`,
      ).bind(context.sessionId, command.id, context.sessionId, auditId, command.id),
      ...rules.map(rule => this.db.prepare(
        `INSERT INTO policy_rules
          (id, session_id, policy_version_id, rule_type, priority,
           conditions_json, outcome_json, explanation_template, active)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM audit_events
             WHERE session_id = ? AND id = ? AND entity_id = ?
          )`,
      ).bind(
        rule.id, context.sessionId, command.id, rule.ruleType, rule.priority,
        JSON.stringify(rule.conditions), JSON.stringify(rule.outcome), rule.explanation,
        rule.active ? 1 : 0, context.sessionId, auditId, command.id,
      )),
    ];
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      await this.throwWriteConflict(command.id, command.expectedVersion, context);
    }
    return this.loadVersion(command.id, context.sessionId);
  }

  async validateDraft(id: string, context: HumanContext): Promise<PolicyValidation> {
    assertHuman(context);
    const row = await this.findRow(context.sessionId, id);
    if (row === null) throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_policies");
    if (row.status !== "draft") throw new DomainError("POLICY_NOT_DRAFT", 409, false, "create_policy_draft");
    const policy = await this.policies.findById(context.sessionId, id);
    if (policy === null) throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_policies");
    const conflicts = findPolicyConflicts(policy.rules);
    return { valid: conflicts.length === 0, conflicts };
  }

  async activate(command: ActivatePolicy, context: HumanContext): Promise<PolicyVersion> {
    assertHuman(context);
    const validation = await this.validateDraft(command.id, context);
    if (!validation.valid) {
      throw new DomainError("POLICY_RULE_CONFLICT", 422, false, "resolve_policy_conflicts");
    }
    const auditId = this.ids.next("audit");
    const now = this.clock.now().toISOString();
    const results = await this.db.batch([
      this.db.prepare(
        `INSERT INTO audit_events
          (id, session_id, case_id, actor_type, actor_id, event_type,
           entity_type, entity_id, summary, metadata_json, created_at)
         SELECT ?, ?, NULL, 'human', ?, 'policy.activated', 'policy_version', ?,
                'Activated a policy version.',
                json_object(
                  'formerActivePolicyVersionId', (
                    SELECT active.id FROM policy_versions active
                     WHERE active.session_id = pv.session_id
                       AND active.status = 'active' AND active.id <> pv.id
                     ORDER BY active.version_number DESC LIMIT 1
                  ),
                  'version', ?
                ), ?
           FROM policy_versions pv
           JOIN demo_sessions ds ON ds.id = pv.session_id
          WHERE pv.session_id = ? AND pv.id = ? AND pv.status = 'draft'
            AND pv.version = ? AND ds.seed_version = ?`,
      ).bind(
        auditId, context.sessionId, context.actor.id, command.id,
        command.expectedVersion + 1, now,
        context.sessionId, command.id, command.expectedVersion, context.seedVersion,
      ),
      this.db.prepare(
        `UPDATE policy_versions
            SET status = 'retired', effective_to = ?
          WHERE session_id = ? AND status = 'active' AND id <> ?
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE session_id = ? AND id = ? AND entity_id = ?
            )`,
      ).bind(now, context.sessionId, command.id, context.sessionId, auditId, command.id),
      this.db.prepare(
        `UPDATE policy_versions
            SET status = 'active', effective_from = ?, effective_to = NULL,
                version = version + 1
          WHERE session_id = ? AND id = ? AND status = 'draft' AND version = ?
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE session_id = ? AND id = ? AND entity_id = ?
            )`,
      ).bind(
        now, context.sessionId, command.id, command.expectedVersion,
        context.sessionId, auditId, command.id,
      ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      await this.throwWriteConflict(command.id, command.expectedVersion, context);
    }
    return this.loadVersion(command.id, context.sessionId);
  }

  private async loadVersion(id: string, sessionId: string): Promise<PolicyVersion> {
    const row = await this.findRow(sessionId, id);
    const definition = await this.policies.findById(sessionId, id);
    if (row === null || definition === null) {
      throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_policies");
    }
    return {
      id: row.id,
      versionNumber: row.version_number,
      name: row.name,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      defaultWindowDays: row.default_window_days,
      absoluteMaxWindowDays: row.absolute_max_window_days,
      defaultReturnRequired: row.default_return_required === 1,
      defaultResolutions: definition.defaultResolutions,
      returnShippingPayer: row.return_shipping_payer,
      status: row.status,
      version: row.version,
      rules: definition.rules,
    };
  }

  private findRow(sessionId: string, id: string): Promise<PolicyAdminRow | null> {
    return this.db.prepare(
      `SELECT id, version_number, name, effective_from, effective_to,
              default_window_days, absolute_max_window_days,
              default_return_required, default_resolutions_json,
              return_shipping_payer, status, version
         FROM policy_versions
        WHERE session_id = ? AND id = ?`,
    ).bind(sessionId, id).first<PolicyAdminRow>();
  }

  private async throwWriteConflict(
    id: string,
    expectedVersion: number,
    context: HumanContext,
  ): Promise<never> {
    const session = await this.db.prepare(
      "SELECT seed_version FROM demo_sessions WHERE id = ?",
    ).bind(context.sessionId).first<{ seed_version: number }>();
    if (session === null || session.seed_version !== context.seedVersion) {
      throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
    }
    const row = await this.findRow(context.sessionId, id);
    if (row === null) throw new DomainError("POLICY_VERSION_NOT_FOUND", 404, false, "reload_policies");
    if (row.status !== "draft") throw new DomainError("POLICY_NOT_DRAFT", 409, false, "create_policy_draft");
    if (row.version !== expectedVersion) {
      throw new DomainError("ENTITY_VERSION_CONFLICT", 409, false, "reload_policy");
    }
    throw new DomainError("POLICY_WRITE_CONFLICT", 409, true, "retry_policy_update");
  }
}

function validatePolicyHeader(command: UpdatePolicyDraft): void {
  if (
    command.id.length < 1 || command.id.length > 64
    || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1
  ) {
    throw new DomainError("INVALID_POLICY_DRAFT", 422, false, "correct_policy_fields");
  }
  try {
    validatePolicyHeaderDefinition(command);
  } catch {
    throw new DomainError("INVALID_POLICY_DRAFT", 422, false, "correct_policy_fields");
  }
}

function validateRules(inputs: UpdatePolicyDraft["rules"]): PolicyRule[] {
  const ids = new Set<string>();
  try {
    return inputs.map(input => {
      if (ids.has(input.id)) throw new Error("duplicate rule id");
      ids.add(input.id);
      return validatePolicyRuleDraft(input);
    });
  } catch {
    throw new DomainError("INVALID_POLICY_DRAFT", 422, false, "correct_policy_rules");
  }
}

export function findPolicyConflicts(rules: readonly PolicyRule[]): PolicyConflict[] {
  const conflicts: PolicyConflict[] = [];
  const active = rules.filter(rule => rule.active);
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const left = active[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const right = active[rightIndex]!;
      if (
        ruleLayer(left.ruleType) !== ruleLayer(right.ruleType)
        || left.priority !== right.priority
        || canonicalJson(left.conditions) !== canonicalJson(right.conditions)
      ) continue;
      for (const field of Object.keys(left.outcome)) {
        if (!(field in right.outcome)) continue;
        const leftValue = left.outcome[field as keyof PolicyRule["outcome"]];
        const rightValue = right.outcome[field as keyof PolicyRule["outcome"]];
        if (
          canonicalJson(normalizePolicyOutcomeValue(field as keyof PolicyRule["outcome"], leftValue))
          === canonicalJson(normalizePolicyOutcomeValue(field as keyof PolicyRule["outcome"], rightValue))
        ) continue;
        conflicts.push({
          layer: ruleLayer(left.ruleType),
          priority: left.priority,
          field,
          ruleIds: [left.id, right.id].sort(compareCodePoints),
        });
      }
    }
  }
  return conflicts.sort((left, right) =>
    left.layer - right.layer
    || right.priority - left.priority
    || compareCodePoints(left.field, right.field)
    || compareRuleIds(left.ruleIds, right.ruleIds),
  );
}

function compareRuleIds(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftId = left[index];
    const rightId = right[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const compared = compareCodePoints(leftId, rightId);
    if (compared !== 0) return compared;
  }
  return 0;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertHuman(context: HumanContext): void {
  if (context.actor.type !== "human") {
    throw new DomainError("CAPABILITY_DENIED", 403, false, "use_human_controls");
  }
}
