import type { RequestContext } from "../http/context";
import { DomainError } from "./errors";
import type { Clock } from "./primitives";
import { systemClock } from "./primitives";

export type ApprovalQueueType = "rma_proposal" | "eligibility_review";

export interface ApprovalQueueInput {
  type?: ApprovalQueueType;
  cursor?: string;
  limit?: number;
}

interface QueueRow {
  id: string;
  type: ApprovalQueueType;
  status: "pending" | "needs_review";
  case_id: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  resolution_type: string | null;
  merchant_cost_cents: number | null;
  return_required: number;
  created_at: string;
  expires_at: string;
}

interface QueueCursor { timestamp: string; id: string }

export class ApprovalQueueService {
  constructor(private readonly db: D1Database, private readonly clock: Clock = systemClock) {}

  async list(input: ApprovalQueueInput, context: RequestContext) {
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20)));
    const cursor = decodeCursor(input.cursor);
    const now = this.clock.now().toISOString();
    const rows = await this.db.prepare(
      `SELECT * FROM (
         SELECT rp.id, 'rma_proposal' AS type, 'pending' AS status,
                rp.case_id, rc.order_id, o.order_number, c.name AS customer_name,
                rp.resolution_type, rp.merchant_cost_cents, rp.return_required,
                rp.created_at, rp.expires_at
           FROM rma_proposals rp
           JOIN return_cases rc ON rc.session_id = rp.session_id AND rc.id = rp.case_id
           JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
           JOIN customers c ON c.session_id = rc.session_id AND c.id = rc.customer_id
          WHERE rp.session_id = ? AND rc.session_id = ? AND o.session_id = ? AND c.session_id = ?
            AND rp.status = 'pending' AND rp.expires_at > ?
         UNION ALL
         SELECT ec.id, 'eligibility_review' AS type, 'needs_review' AS status,
                ec.case_id, rc.order_id, o.order_number, c.name AS customer_name,
                NULL AS resolution_type, NULL AS merchant_cost_cents, ec.return_required,
                ec.created_at, ec.expires_at
           FROM eligibility_checks ec
           JOIN return_cases rc ON rc.session_id = ec.session_id AND rc.id = ec.case_id
           JOIN orders o ON o.session_id = rc.session_id AND o.id = rc.order_id
           JOIN customers c ON c.session_id = rc.session_id AND c.id = rc.customer_id
          WHERE ec.session_id = ? AND rc.session_id = ? AND o.session_id = ? AND c.session_id = ?
            AND ec.status = 'needs_review' AND ec.expires_at > ?
            AND NOT EXISTS (
              SELECT 1 FROM eligibility_checks child
               WHERE child.session_id = ec.session_id AND child.parent_check_id = ec.id
            )
       ) queue
       WHERE (? IS NULL OR type = ?)
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).bind(
      context.sessionId, context.sessionId, context.sessionId, context.sessionId,
      now,
      context.sessionId, context.sessionId, context.sessionId, context.sessionId,
      now,
      input.type ?? null, input.type ?? null,
      cursor?.timestamp ?? null, cursor?.timestamp ?? null,
      cursor?.timestamp ?? null, cursor?.id ?? null, limit,
    ).all<QueueRow>();
    const items = rows.results.map(row => ({
      id: row.id,
      type: row.type,
      status: row.status,
      caseId: row.case_id,
      orderId: row.order_id,
      orderNumber: row.order_number,
      customerDisplayName: maskName(row.customer_name),
      resolutionType: row.resolution_type,
      merchantCostCents: row.merchant_cost_cents,
      returnRequired: row.return_required === 1,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
    const last = rows.results.length === limit ? rows.results.at(-1) : undefined;
    return { items, nextCursor: last === undefined ? null : encodeCursor({ timestamp: last.created_at, id: last.id }) };
  }
}

function encodeCursor(cursor: QueueCursor): string {
  return btoa(JSON.stringify({ v: 1, t: cursor.timestamp, i: cursor.id }))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(value: string | undefined): QueueCursor | null {
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

function maskName(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  const first = parts[0];
  if (first === undefined) return "Customer";
  const last = parts.at(-1);
  return last === undefined || last === first ? `${first.slice(0, 1)}.` : `${first} ${last.slice(0, 1)}.`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
