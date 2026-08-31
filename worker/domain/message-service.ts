import type { ResolutionType } from "../../src/shared/contracts/common";
import type { DraftCustomerMessageInput } from "../../src/shared/contracts/tools";
import { AuditRepository, type AuditEventInput } from "../repositories/audit-repository";
import { DomainError } from "./errors";
import type { Clock } from "./primitives";
import { systemClock } from "./primitives";
import { renderEnUs, type TemplateFacts } from "./templates/en-US";
import { renderZhCn } from "./templates/zh-CN";

export interface MessageFacts {
  CUSTOMER_NAME: string | undefined;
  ORDER_NUMBER: string | undefined;
  RESOLUTION: ResolutionType | undefined;
  RETURN_REQUIRED: boolean | undefined;
  EXPIRES_AT?: string | undefined;
}

export type MessageFactName = keyof TemplateFacts;

interface MessageFactSource {
  resolve(input: DraftCustomerMessageInput, sessionId: string): Promise<MessageFacts>;
}

interface AuditSink {
  append(input: AuditEventInput): Promise<unknown>;
}

export interface MessageContext {
  sessionId: string;
  actor: { type: "agent" | "human" | "system"; id: string };
}

export interface MessageDraft {
  subject: string;
  bodyText: string;
  factsUsed: readonly MessageFactName[];
  missingInformation: readonly MessageFactName[];
  sendStatus: "not_sent";
}

const REQUIRED_FACTS: readonly MessageFactName[] = [
  "CUSTOMER_NAME", "ORDER_NUMBER", "RESOLUTION", "RETURN_REQUIRED",
];

export class MessageService {
  private readonly source: MessageFactSource;
  private readonly audits: AuditSink | null;

  constructor(
    source: D1Database | MessageFactSource,
    audits?: AuditSink,
    private readonly clock: Clock = systemClock,
  ) {
    if (isDatabase(source)) {
      this.source = new D1MessageFactSource(source);
      this.audits = audits ?? new AuditRepository(source, clock);
    } else {
      this.source = source;
      this.audits = audits ?? null;
    }
  }

  async draft(input: DraftCustomerMessageInput, context: MessageContext): Promise<MessageDraft> {
    const rawFacts = await this.source.resolve(input, context.sessionId);
    if (
      rawFacts.EXPIRES_AT !== undefined
      && this.clock.now().getTime() >= new Date(rawFacts.EXPIRES_AT).getTime()
    ) {
      throw new DomainError("ELIGIBILITY_CHECK_STALE", 409, false, "check_return_eligibility");
    }
    const customerName = normalizeCustomerName(rawFacts.CUSTOMER_NAME);
    const orderNumber = normalizeOrderNumber(rawFacts.ORDER_NUMBER);
    const missing = REQUIRED_FACTS.filter(name => {
      if (name === "CUSTOMER_NAME") return customerName === undefined;
      if (name === "ORDER_NUMBER") return orderNumber === undefined;
      return rawFacts[name] === undefined;
    });
    if (missing.length > 0) {
      return { subject: "", bodyText: "", factsUsed: [], missingInformation: missing, sendStatus: "not_sent" };
    }
    const facts: TemplateFacts = {
      CUSTOMER_NAME: customerName as string,
      ORDER_NUMBER: orderNumber as string,
      RESOLUTION: rawFacts.RESOLUTION as ResolutionType,
      RETURN_REQUIRED: rawFacts.RETURN_REQUIRED as boolean,
    };
    const rendered = input.locale === "zh-CN"
      ? renderZhCn(facts, input.tone)
      : renderEnUs(facts, input.tone);
    await this.audits?.append({
      sessionId: context.sessionId,
      caseId: input.caseId,
      actorType: context.actor.type,
      actorId: context.actor.id,
      eventType: "message.drafted",
      entityType: "eligibility_check",
      entityId: input.eligibilityCheckId,
      summary: "Drafted a customer message.",
      metadata: { locale: input.locale, resolutionType: input.resolutionType },
    });
    return {
      ...rendered,
      factsUsed: REQUIRED_FACTS,
      missingInformation: [],
      sendStatus: "not_sent",
    };
  }
}

interface MessageRow {
  customer_name: string;
  order_number: string;
  status: string;
  calculation_snapshot_json: string;
  expires_at: string;
}

class D1MessageFactSource implements MessageFactSource {
  constructor(private readonly db: D1Database) {}

  async resolve(input: DraftCustomerMessageInput, sessionId: string): Promise<MessageFacts> {
    const row = await this.db.prepare(
      `SELECT c.name AS customer_name, o.order_number, ec.status,
              ec.calculation_snapshot_json, ec.expires_at
         FROM return_cases rc
         JOIN customers c ON c.session_id = rc.session_id AND c.id = rc.customer_id
         JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
         JOIN eligibility_checks ec
           ON ec.session_id = rc.session_id AND ec.case_id = rc.id
        WHERE rc.session_id = ? AND c.session_id = ? AND o.session_id = ?
          AND ec.session_id = ? AND rc.id = ? AND ec.id = ?`,
    ).bind(sessionId, sessionId, sessionId, sessionId, input.caseId, input.eligibilityCheckId)
      .first<MessageRow>();
    if (row === null) {
      throw new DomainError("CASE_RELATION_MISMATCH", 409, false, "reload_case");
    }
    if (row.status !== "eligible") {
      throw new DomainError("ELIGIBILITY_NOT_ELIGIBLE", 422, false, "review_eligibility");
    }
    const option = findOption(row.calculation_snapshot_json, input.resolutionType, input.replacementVariantId);
    if (option === null) {
      throw new DomainError("RESOLUTION_NOT_ALLOWED", 422, false, "compare_allowed_resolutions");
    }
    return {
      CUSTOMER_NAME: row.customer_name,
      ORDER_NUMBER: row.order_number,
      RESOLUTION: input.resolutionType,
      RETURN_REQUIRED: option.returnRequired,
      EXPIRES_AT: row.expires_at,
    };
  }
}

function findOption(
  snapshotJson: string,
  resolutionType: ResolutionType,
  replacementVariantId: string | undefined,
): { returnRequired: boolean } | null {
  const parsed: unknown = JSON.parse(snapshotJson);
  if (!isRecord(parsed) || !isRecord(parsed.decision) || !Array.isArray(parsed.decision.allowedResolutions)) {
    throw new DomainError("INVALID_ELIGIBILITY_SNAPSHOT", 500, false);
  }
  for (const value of parsed.decision.allowedResolutions) {
    if (!isRecord(value) || value.type !== resolutionType || typeof value.returnRequired !== "boolean") continue;
    if (resolutionType === "exchange" && value.replacementVariantId !== replacementVariantId) continue;
    return { returnRequired: value.returnRequired };
  }
  return null;
}

function normalizeCustomerName(value: string | undefined): string | undefined {
  return normalizeTemplateFact(value, 160);
}

function normalizeOrderNumber(value: string | undefined): string | undefined {
  return normalizeTemplateFact(value, 120);
}

function normalizeTemplateFact(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDatabase(value: D1Database | MessageFactSource): value is D1Database {
  return "prepare" in value && typeof value.prepare === "function";
}
