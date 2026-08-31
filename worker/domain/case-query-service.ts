import type { RequestContext } from "../http/context";
import { DomainError } from "./errors";
import { ProposalService } from "./proposal-service";
import { ProposalRepository } from "../repositories/proposal-repository";
import { ApprovalRepository } from "../repositories/approval-repository";
import { DemoCommerceAdapter } from "../demo/demo-commerce-adapter";
import { systemClock, cryptoIds, type Clock, type IdGenerator } from "./primitives";
import type {
  AllowedResolution,
  EligibilityDecision,
  MatchedPolicyRule,
  ReturnShippingPayer,
} from "./policy/types";

export interface PageInput { cursor?: string; limit?: number }

export interface CaseListInput extends PageInput { status?: string }

interface CaseListRow {
  id: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  status: string;
  reason_code: string;
  condition_code: string;
  updated_at: string;
  version: number;
}

interface WorkspaceRow extends CaseListRow {
  opened_at: string;
  latest_check_id: string | null;
  calculation_snapshot_json: string | null;
  pending_proposal_id: string | null;
}

export interface PublicEligibilityConflict {
  layer: number;
  priority: number;
  field: string;
  ruleIds: readonly string[];
}

export interface PublicEligibility {
  eligibilityCheckId: string;
  status: EligibilityDecision["status"];
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
  conflictEvidence: PublicEligibilityConflict | null;
  proposalSubmissionAllowed: boolean;
}

interface ActivityRow {
  id: string;
  actor_type: "agent" | "human" | "system";
  event_type: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  created_at: string;
}

export class CaseQueryService {
  constructor(private readonly db: D1Database, private readonly clock: Clock = systemClock, private readonly ids: IdGenerator = cryptoIds) {}

  async list(input: CaseListInput, context: RequestContext) {
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = await this.db.prepare(
      `SELECT rc.id, rc.order_id, o.order_number, c.name AS customer_name,
              rc.status, rc.reason_code, rc.condition_code, rc.updated_at, rc.version
         FROM return_cases rc
         JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
         JOIN customers c ON c.session_id = rc.session_id AND c.id = rc.customer_id
        WHERE rc.session_id = ? AND o.session_id = ? AND c.session_id = ?
          AND (? IS NULL OR rc.status = ?)
          AND (? IS NULL OR rc.updated_at < ? OR (rc.updated_at = ? AND rc.id < ?))
        ORDER BY rc.updated_at DESC, rc.id DESC LIMIT ?`,
    ).bind(
      context.sessionId, context.sessionId, context.sessionId,
      input.status ?? null, input.status ?? null,
      cursor?.timestamp ?? null, cursor?.timestamp ?? null,
      cursor?.timestamp ?? null, cursor?.id ?? null, limit,
    ).all<CaseListRow>();
    const items = rows.results.map(toCaseSummary);
    return { items, nextCursor: nextCursor(rows.results, limit, row => ({ timestamp: row.updated_at, id: row.id })) };
  }

  async getWorkspace(caseId: string, context: RequestContext) {
    const latest = await this.db.prepare("SELECT id FROM rma_proposals WHERE session_id = ? AND case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .bind(context.sessionId, caseId).first<{ id: string }>();
    const proposal = latest === null ? null : await new ProposalService(this.db, this.clock, this.ids).read(latest.id, context);
    const proposalRecord = latest === null ? null : await new ProposalRepository(this.db).findById(context.sessionId, latest.id);
    const row = await this.db.prepare(
      `SELECT rc.id, rc.order_id, o.order_number, c.name AS customer_name,
              rc.status, rc.reason_code, rc.condition_code, rc.opened_at,
              rc.updated_at, rc.version,
              ec.id AS latest_check_id,
              ec.calculation_snapshot_json,
              rp.id AS pending_proposal_id
         FROM return_cases rc
         JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
         JOIN customers c ON c.session_id = rc.session_id AND c.id = rc.customer_id
         LEFT JOIN eligibility_checks ec
           ON ec.session_id = rc.session_id AND ec.id = (
             SELECT newest.id FROM eligibility_checks newest
              WHERE newest.session_id = rc.session_id AND newest.case_id = rc.id
              ORDER BY newest.created_at DESC, newest.id DESC LIMIT 1
           )
         LEFT JOIN rma_proposals rp
           ON rp.session_id = rc.session_id AND rp.id = (
             SELECT pending.id FROM rma_proposals pending
              WHERE pending.session_id = rc.session_id AND pending.case_id = rc.id
                AND pending.status = 'pending'
              ORDER BY pending.created_at DESC, pending.id DESC LIMIT 1
           )
        WHERE rc.session_id = ? AND o.session_id = ? AND c.session_id = ? AND rc.id = ?`,
    ).bind(context.sessionId, context.sessionId, context.sessionId, caseId).first<WorkspaceRow>();
    if (row === null) throw new DomainError("CASE_NOT_FOUND", 404, false, "reload_cases");
    return {
      ...toCaseSummary(row),
      openedAt: row.opened_at,
      latestEligibility: row.latest_check_id === null
        ? null
        : toPublicEligibility(row.latest_check_id, row.calculation_snapshot_json),
      pendingProposalId: row.pending_proposal_id,
      proposal: proposal === null ? null : { ...proposal, customerMessage: proposalRecord!.customerMessage },
      completion: proposal?.status === "approved" ? await new ApprovalRepository(this.db).findCompleted(context.sessionId, proposal.proposalId) : null,
      order: await new DemoCommerceAdapter(this.db).getOrder(context.sessionId, row.order_id),
      customerNote: (await this.db.prepare("SELECT customer_note FROM return_cases WHERE session_id = ? AND id = ?")
        .bind(context.sessionId, caseId).first<{ customer_note: string | null }>())?.customer_note ?? null,
    };
  }

  async getActivity(caseId: string, input: PageInput, context: RequestContext) {
    const owned = await this.db.prepare(
      "SELECT id FROM return_cases WHERE session_id = ? AND id = ?",
    ).bind(context.sessionId, caseId).first<{ id: string }>();
    if (owned === null) throw new DomainError("CASE_NOT_FOUND", 404, false, "reload_case");
    const limit = pageLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const rows = await this.db.prepare(
      `SELECT id, actor_type, event_type, entity_type, entity_id, summary, created_at
         FROM audit_events
        WHERE session_id = ? AND case_id = ?
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(
      context.sessionId, caseId,
      cursor?.timestamp ?? null, cursor?.timestamp ?? null,
      cursor?.timestamp ?? null, cursor?.id ?? null, limit,
    ).all<ActivityRow>();
    const items = rows.results.map(row => ({
      id: row.id,
      actorType: row.actor_type,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      createdAt: row.created_at,
    }));
    return { items, nextCursor: nextCursor(rows.results, limit, row => ({ timestamp: row.created_at, id: row.id })) };
  }
}

function toCaseSummary(row: CaseListRow) {
  return {
    caseId: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    customerDisplayName: maskName(row.customer_name),
    status: row.status,
    reasonCode: row.reason_code,
    conditionCode: row.condition_code,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

interface Cursor { timestamp: string; id: string }

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify({ v: 1, t: cursor.timestamp, i: cursor.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const parsed: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.t !== "string" || typeof parsed.i !== "string") {
      throw new Error("invalid cursor");
    }
    if (parsed.t.length > 40 || parsed.i.length < 1 || parsed.i.length > 64) throw new Error("invalid cursor");
    return { timestamp: parsed.t, id: parsed.i };
  } catch {
    throw new DomainError("INVALID_CURSOR", 400, false, "restart_pagination");
  }
}

function nextCursor<T>(rows: readonly T[], limit: number, get: (row: T) => Cursor): string | null {
  const last = rows.length === limit ? rows.at(-1) : undefined;
  return last === undefined ? null : encodeCursor(get(last));
}

function pageLimit(limit: number | undefined): number {
  return Math.min(50, Math.max(1, Math.trunc(limit ?? 20)));
}

function maskName(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return "Customer";
  const last = parts.at(-1);
  return last === undefined || last === first ? `${first.slice(0, 1)}.` : `${first} ${last.slice(0, 1)}.`;
}

function toPublicEligibility(
  eligibilityCheckId: string,
  snapshotJson: string | null,
): PublicEligibility {
  let parsed: unknown;
  try {
    parsed = snapshotJson === null ? null : JSON.parse(snapshotJson) as unknown;
  } catch {
    throw new DomainError("INVALID_ELIGIBILITY_SNAPSHOT", 500, false);
  }
  if (!isRecord(parsed) || !isRecord(parsed.decision)) {
    throw new DomainError("INVALID_ELIGIBILITY_SNAPSHOT", 500, false);
  }
  const decision = parsed.decision as unknown as EligibilityDecision;
  if (
    !Array.isArray(decision.allowedResolutions)
    || !Array.isArray(decision.reasonCodes)
    || !Array.isArray(decision.matchedRules)
    || !Array.isArray(decision.missingInformation)
  ) {
    throw new DomainError("INVALID_ELIGIBILITY_SNAPSHOT", 500, false);
  }
  return {
    eligibilityCheckId,
    status: decision.status,
    policyVersionId: decision.policyVersionId,
    policyName: decision.policyName,
    requestedQuantity: decision.requestedQuantity,
    remainingReturnableQuantity: decision.remainingReturnableQuantity,
    allowedResolutions: decision.allowedResolutions.map(option => ({
      type: option.type,
      customerOutcome: option.customerOutcome,
      merchantCostCents: option.merchantCostCents,
      amountCents: option.amountCents,
      currency: option.currency,
      returnRequired: option.returnRequired,
      customerConsentRequired: option.customerConsentRequired,
      replacementVariantId: option.replacementVariantId,
      replacementSku: option.replacementSku,
      inventoryQuantity: option.inventoryQuantity,
      inventoryVersion: option.inventoryVersion,
      recommendationReasons: [...option.recommendationReasons],
    })),
    returnRequired: decision.returnRequired,
    returnShippingPayer: decision.returnShippingPayer,
    reasonCodes: [...decision.reasonCodes],
    matchedRules: decision.matchedRules.map(rule => ({
      ruleId: rule.ruleId,
      layer: rule.layer,
      priority: rule.priority,
      effect: rule.effect,
      explanation: rule.explanation,
    })),
    missingInformation: [...decision.missingInformation],
    windowEndsAt: decision.windowEndsAt,
    elapsedDays: decision.elapsedDays,
    expiresAt: decision.expiresAt,
    conflictEvidence: decision.conflictEvidence === null ? null : {
      layer: decision.conflictEvidence.layer,
      priority: decision.conflictEvidence.priority,
      field: decision.conflictEvidence.field,
      ruleIds: [...decision.conflictEvidence.ruleIds],
    },
    proposalSubmissionAllowed: decision.proposalSubmissionAllowed,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
