import { describe, expect, it } from "vitest";

import { EligibilityService } from "../../worker/domain/eligibility-service";
import {
  ProposalService,
  type HumanContext,
  type ReplaceProposal,
  type SubmitProposal,
} from "../../worker/domain/proposal-service";
import type { Clock, IdGenerator } from "../../worker/domain/primitives";
import type { RequestContext } from "../../worker/http/context";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { db } from "./setup";

const liveClock: Clock = { now: () => new Date("2026-08-29T07:00:00.000Z") };
const expiredClock: Clock = { now: () => new Date("2026-08-29T08:00:00.000Z") };

class SequenceIds implements IdGenerator {
  private sequence = 0;
  constructor(private readonly namespace: string) {}
  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_proposal_${this.namespace}_${this.sequence}`;
  }
}

let fixtureSequence = 0;

async function fixture() {
  fixtureSequence += 1;
  const ids = new SequenceIds(String(fixtureSequence));
  const session = await new SessionRepository(db, liveClock, ids).getOrCreate(null);
  const facts = await db.prepare(
    `SELECT o.id AS order_id, oi.id AS order_item_id, replacement.id AS replacement_id
       FROM orders o
       JOIN order_items oi ON oi.session_id = o.session_id AND oi.order_id = o.id
       JOIN product_variants original ON original.session_id = oi.session_id AND original.id = oi.variant_id
       JOIN product_variants replacement
         ON replacement.session_id = original.session_id
        AND replacement.product_id = original.product_id
        AND replacement.id <> original.id
      WHERE o.session_id = ? AND o.order_number = 'ORD-1001'`,
  ).bind(session.id).first<{ order_id: string; order_item_id: string; replacement_id: string }>();
  if (facts === null) throw new Error("missing proposal fixture");
  const agent: RequestContext = {
    sessionId: session.id,
    seedVersion: session.seedVersion,
    csrfToken: "csrf",
    actor: { type: "agent", id: "agent:test" },
    requestId: `req-${fixtureSequence}`,
  };
  const human: HumanContext = { ...agent, actor: { type: "human", id: "merchant:test" } };
  const eligible = await new EligibilityService(db, liveClock, ids).check({
    orderId: facts.order_id,
    orderItemId: facts.order_item_id,
    requestedQuantity: 1,
    reasonCode: "wrong_size",
    conditionCode: "opened_unused",
    replacementVariantId: facts.replacement_id,
    storeCreditConsent: true,
    idempotencyKey: `elig-${fixtureSequence}`,
  }, agent);
  const command: SubmitProposal = {
    caseId: eligible.caseId,
    eligibilityCheckId: eligible.eligibilityCheckId,
    resolutionType: "refund",
    customerMessage: { subject: "Return approved for review", bodyText: "Please review.", locale: "en-US" },
    idempotencyKey: `proposal-${fixtureSequence}`,
  };
  return {
    session,
    ids,
    agent,
    human,
    eligible,
    command,
    orderItemId: facts.order_item_id,
    replacementVariantId: facts.replacement_id,
    service: new ProposalService(db, liveClock, ids),
  };
}

function replace(proposalId: string, command: SubmitProposal, overrides: Partial<ReplaceProposal> = {}): ReplaceProposal {
  return {
    proposalId,
    expectedVersion: 1,
    ...command,
    customerMessage: { ...command.customerMessage, subject: "Replacement proposal" },
    idempotencyKey: `${command.idempotencyKey}-replacement`,
    ...overrides,
  };
}

describe("ProposalService", () => {
  it("submits from an eligible snapshot without creating a formal RMA and replays the same key/hash", async () => {
    const f = await fixture();
    const first = await f.service.submit(f.command, f.agent);
    await db.prepare("UPDATE eligibility_checks SET expires_at = ? WHERE session_id = ? AND id = ?")
      .bind("2026-08-29T07:00:00.000Z", f.session.id, f.eligible.eligibilityCheckId).run();
    const replay = await f.service.submit({ ...f.command, customerMessage: { ...f.command.customerMessage } }, f.agent);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "pending", caseId: f.eligible.caseId, executedEffects: [] });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ?")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM rmas WHERE session_id = ?")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 0 });
    const audit = await db.prepare(
      "SELECT metadata_json FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.submitted' AND entity_id = ?",
    ).bind(f.session.id, first.proposalId).first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toEqual({
      fromStatus: null,
      toStatus: "pending",
      resolutionType: "refund",
      requestedQuantity: 1,
      amountCents: 12900,
      replacementVariantId: null,
      replacementSku: null,
    });
  });

  it("rejects idempotency-key reuse with a different canonical payload", async () => {
    const f = await fixture();
    await f.service.submit(f.command, f.agent);
    await expect(f.service.submit({
      ...f.command,
      customerMessage: { ...f.command.customerMessage, bodyText: "Different" },
    }, f.agent)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", httpStatus: 409 });
  });

  it("returns stable pending conflict for simultaneous different agent submissions", async () => {
    const f = await fixture();
    const commands = [f.command, { ...f.command, idempotencyKey: `${f.command.idempotencyKey}-other`, customerMessage: {
      ...f.command.customerMessage, subject: "Other proposal",
    } }];
    const outcomes = await Promise.allSettled(commands.map(command => f.service.submit(command, f.agent)));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "PENDING_PROPOSAL_CONFLICT", httpStatus: 409 } });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ? AND case_id = ? AND status = 'pending'",
    ).bind(f.session.id, f.eligible.caseId).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("rejects stale, non-eligible, and cross-session snapshots", async () => {
    const first = await fixture();
    await db.prepare("UPDATE eligibility_checks SET expires_at = ? WHERE session_id = ? AND id = ?")
      .bind("2026-08-29T07:00:00.000Z", first.session.id, first.eligible.eligibilityCheckId).run();
    await expect(first.service.submit(first.command, first.agent)).rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_STALE" });

    const changedFacts = await fixture();
    await db.prepare(
      `UPDATE product_variants
          SET inventory_quantity = inventory_quantity - 1, inventory_version = inventory_version + 1
        WHERE session_id = ? AND id = (
          SELECT json_extract(calculation_snapshot_json, '$.input.replacementVariant.id')
            FROM eligibility_checks WHERE session_id = ? AND id = ?
        )`,
    ).bind(
      changedFacts.session.id, changedFacts.session.id, changedFacts.eligible.eligibilityCheckId,
    ).run();
    await expect(changedFacts.service.submit(changedFacts.command, changedFacts.agent))
      .resolves.toMatchObject({ status: "pending", resolutionType: "refund" });

    const changedCredit = await fixture();
    await db.prepare(
      `UPDATE product_variants
          SET inventory_quantity = inventory_quantity - 1, inventory_version = inventory_version + 1
        WHERE session_id = ? AND id = ?`,
    ).bind(changedCredit.session.id, changedCredit.replacementVariantId).run();
    await expect(changedCredit.service.submit({
      ...changedCredit.command,
      resolutionType: "store_credit",
      idempotencyKey: "store-credit-inventory-independent",
    }, changedCredit.agent)).resolves.toMatchObject({
      status: "pending", resolutionType: "store_credit",
    });

    const second = await fixture();
    await db.prepare("UPDATE eligibility_checks SET status = 'ineligible' WHERE session_id = ? AND id = ?")
      .bind(second.session.id, second.eligible.eligibilityCheckId).run();
    await expect(second.service.submit(second.command, second.agent)).rejects.toMatchObject({ code: "ELIGIBILITY_NOT_ELIGIBLE" });

    await expect(second.service.read(first.eligible.eligibilityCheckId, second.agent))
      .rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND", httpStatus: 404 });
  });

  it("claims submit ownership with current facts at the D1 batch boundary", async () => {
    const f = await fixture();
    const before = await db.prepare("SELECT version FROM return_cases WHERE session_id = ? AND id = ?")
      .bind(f.session.id, f.eligible.caseId).first<{ version: number }>();
    const service = new ProposalService(db, liveClock, f.ids, {
      beforeBatch: async operation => {
        if (operation !== "submit") return;
        await db.prepare(
          "UPDATE order_items SET unit_price_cents = unit_price_cents + 1 WHERE session_id = ? AND id = ?",
        ).bind(f.session.id, f.orderItemId).run();
      },
    });
    await expect(service.submit(f.command, f.agent))
      .rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_STALE" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ?")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.submitted'")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 0 });
    expect(await db.prepare("SELECT version FROM return_cases WHERE session_id = ? AND id = ?")
      .bind(f.session.id, f.eligible.caseId).first<{ version: number }>()).toEqual(before);
  });

  it("guards replacement inventory only for exchange at the D1 batch boundary", async () => {
    const f = await fixture();
    const exchange: SubmitProposal = {
      ...f.command,
      resolutionType: "exchange",
      replacementVariantId: f.replacementVariantId,
      idempotencyKey: "exchange-boundary",
    };
    const service = new ProposalService(db, liveClock, f.ids, {
      beforeBatch: async operation => {
        if (operation !== "submit") return;
        await db.prepare(
          `UPDATE product_variants
              SET inventory_quantity = inventory_quantity - 1, inventory_version = inventory_version + 1
            WHERE session_id = ? AND id = ?`,
        ).bind(f.session.id, f.replacementVariantId).run();
      },
    });
    await expect(service.submit(exchange, f.agent))
      .rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_STALE" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ?")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("records safe exchange SKU facts in submitted audit metadata", async () => {
    const f = await fixture();
    const exchange = await f.service.submit({
      ...f.command,
      resolutionType: "exchange",
      replacementVariantId: f.replacementVariantId,
      idempotencyKey: "exchange-audit",
    }, f.agent);
    const audit = await db.prepare(
      "SELECT metadata_json FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.submitted' AND entity_id = ?",
    ).bind(f.session.id, exchange.proposalId).first<{ metadata_json: string }>();
    expect(JSON.parse(audit!.metadata_json)).toEqual({
      fromStatus: null,
      toStatus: "pending",
      resolutionType: "exchange",
      requestedQuantity: 1,
      amountCents: null,
      replacementVariantId: f.replacementVariantId,
      replacementSku: "SHOE-BLUE-9",
    });
  });

  it("lazily expires once under concurrent readers and writes exactly one system audit", async () => {
    const f = await fixture();
    const proposal = await f.service.submit(f.command, f.agent);
    const expiring = new ProposalService(db, expiredClock, f.ids);
    const reads = await Promise.all([
      expiring.read(proposal.proposalId, f.agent),
      expiring.read(proposal.proposalId, f.agent),
      expiring.read(proposal.proposalId, f.agent),
    ]);
    expect(reads.map(result => result.status)).toEqual(["expired", "expired", "expired"]);
    expect(await db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE session_id = ? AND entity_id = ? AND event_type = 'rma_proposal.expired'
          AND actor_type = 'system'`,
    ).bind(f.session.id, proposal.proposalId).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("allows only a human context to reject and never revives the terminal result", async () => {
    const f = await fixture();
    const proposal = await f.service.submit(f.command, f.agent);
    await expect(f.service.reject({
      proposalId: proposal.proposalId,
      expectedVersion: 1,
      reasonCode: "MERCHANT_DECLINED",
      note: "Reviewed by merchant.",
      idempotencyKey: "reject-agent",
    }, f.agent as HumanContext)).rejects.toMatchObject({ code: "CAPABILITY_DENIED", httpStatus: 403 });
    const rejected = await f.service.reject({
      proposalId: proposal.proposalId,
      expectedVersion: 1,
      reasonCode: "MERCHANT_DECLINED",
      note: "Reviewed by merchant.",
      idempotencyKey: "reject-human",
    }, f.human);
    expect(rejected).toMatchObject({ status: "rejected", version: 2 });
    await expect(f.service.reject({
      proposalId: proposal.proposalId,
      expectedVersion: 2,
      reasonCode: "MERCHANT_DECLINED",
      idempotencyKey: "reject-again",
    }, f.human)).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING", currentState: "rejected" });
  });

  it("atomically supersedes the old proposal, links the new pending proposal, and emits two audits", async () => {
    const f = await fixture();
    const old = await f.service.submit(f.command, f.agent);
    const currentCheck = await new EligibilityService(db, liveClock, f.ids).check({
      caseId: f.eligible.caseId,
      orderId: f.eligible.inputHash ? (await db.prepare("SELECT order_id FROM return_cases WHERE session_id = ? AND id = ?")
        .bind(f.session.id, f.eligible.caseId).first<{ order_id: string }>())!.order_id : "",
      orderItemId: (await db.prepare("SELECT order_item_id FROM eligibility_checks WHERE session_id = ? AND id = ?")
        .bind(f.session.id, f.eligible.eligibilityCheckId).first<{ order_item_id: string }>())!.order_item_id,
      requestedQuantity: 1,
      reasonCode: "wrong_size",
      conditionCode: "opened_unused",
      storeCreditConsent: true,
      idempotencyKey: `elig-replace-${f.session.id}`,
    }, f.human);
    const next = await f.service.replace(replace(old.proposalId, {
      ...f.command,
      eligibilityCheckId: currentCheck.eligibilityCheckId,
    }), f.human);
    expect(next.status).toBe("pending");
    expect(await f.service.read(old.proposalId, f.human)).toMatchObject({
      status: "superseded", supersededByProposalId: next.proposalId,
    });
    expect(await db.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE session_id = ?
          AND ((event_type = 'rma_proposal.superseded' AND entity_id = ?)
            OR (event_type = 'rma_proposal.submitted' AND entity_id = ?))`,
    ).bind(f.session.id, old.proposalId, next.proposalId).first<{ count: number }>()).toEqual({ count: 2 });
    const replacementAudit = await db.prepare(
      "SELECT metadata_json FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.submitted' AND entity_id = ?",
    ).bind(f.session.id, next.proposalId).first<{ metadata_json: string }>();
    expect(JSON.parse(replacementAudit!.metadata_json)).toMatchObject({
      fromStatus: null,
      toStatus: "pending",
      resolutionType: "refund",
      requestedQuantity: 1,
      amountCents: 12900,
      replacementVariantId: null,
      replacementSku: null,
      supersedesProposalId: old.proposalId,
    });
    const supersededAudit = await db.prepare(
      "SELECT metadata_json FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.superseded' AND entity_id = ?",
    ).bind(f.session.id, old.proposalId).first<{ metadata_json: string }>();
    expect(JSON.parse(supersededAudit!.metadata_json)).toEqual({
      fromStatus: "pending",
      toStatus: "superseded",
      resolutionType: "refund",
      requestedQuantity: 1,
      amountCents: 12900,
      replacementVariantId: null,
      replacementSku: null,
      supersededByProposalId: next.proposalId,
    });
  });

  it("leaves the old proposal pending when replacement facts change at the batch boundary", async () => {
    const f = await fixture();
    const old = await f.service.submit(f.command, f.agent);
    const caseRow = await db.prepare("SELECT order_id FROM return_cases WHERE session_id = ? AND id = ?")
      .bind(f.session.id, f.eligible.caseId).first<{ order_id: string }>();
    const currentCheck = await new EligibilityService(db, liveClock, f.ids).check({
      caseId: f.eligible.caseId,
      orderId: caseRow!.order_id,
      orderItemId: f.orderItemId,
      requestedQuantity: 1,
      reasonCode: "wrong_size",
      conditionCode: "opened_unused",
      storeCreditConsent: true,
      idempotencyKey: "elig-replace-boundary",
    }, f.human);
    const service = new ProposalService(db, liveClock, f.ids, {
      beforeBatch: async operation => {
        if (operation !== "replace") return;
        await db.prepare(
          "UPDATE order_items SET unit_price_cents = unit_price_cents + 1 WHERE session_id = ? AND id = ?",
        ).bind(f.session.id, f.orderItemId).run();
      },
    });
    await expect(service.replace(replace(old.proposalId, {
      ...f.command, eligibilityCheckId: currentCheck.eligibilityCheckId,
    }), f.human)).rejects.toMatchObject({ code: "ELIGIBILITY_CHECK_STALE" });
    expect(await service.read(old.proposalId, f.human)).toMatchObject({
      status: "pending", supersededByProposalId: null, version: 1,
    });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ? AND case_id = ?")
      .bind(f.session.id, f.eligible.caseId).first<{ count: number }>()).toEqual({ count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.superseded'")
      .bind(f.session.id).first<{ count: number }>()).toEqual({ count: 0 });
  });

  it("rolls back replace failures and resolves competing replaces to one new pending proposal", async () => {
    const rollbackFixture = await fixture();
    const rollbackOld = await rollbackFixture.service.submit(rollbackFixture.command, rollbackFixture.agent);
    await db.prepare(
      `CREATE TRIGGER fail_task7_replace BEFORE INSERT ON rma_proposals
       WHEN NEW.idempotency_key = 'replace-fail'
       BEGIN SELECT RAISE(ABORT, 'injected replace failure'); END`,
    ).run();
    await expect(rollbackFixture.service.replace(replace(rollbackOld.proposalId, rollbackFixture.command, {
      idempotencyKey: "replace-fail",
    }), rollbackFixture.human)).rejects.toThrow("injected replace failure");
    expect(await rollbackFixture.service.read(rollbackOld.proposalId, rollbackFixture.human)).toMatchObject({ status: "pending" });

    const race = await fixture();
    const raceOld = await race.service.submit(race.command, race.agent);
    const outcomes = await Promise.allSettled([
      race.service.replace(replace(raceOld.proposalId, race.command, { idempotencyKey: "race-a" }), race.human),
      race.service.replace(replace(raceOld.proposalId, race.command, {
        idempotencyKey: "race-b",
        customerMessage: { ...race.command.customerMessage, subject: "Race B" },
      }), race.human),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === "rejected"))
      .toMatchObject({ reason: { code: "PROPOSAL_NOT_PENDING", currentState: "superseded" } });
    expect(await db.prepare(
      "SELECT COUNT(*) AS count FROM rma_proposals WHERE session_id = ? AND case_id = ? AND status = 'pending'",
    ).bind(race.session.id, race.eligible.caseId).first<{ count: number }>()).toEqual({ count: 1 });
  });
});
