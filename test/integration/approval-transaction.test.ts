import { describe, expect, it } from "vitest";
import { ApprovalService } from "../../worker/domain/approval-service";
import { approvalClock, approvalFixture, approvalIds, executionCounts } from "../fixtures/approval";
import { db } from "./setup";

describe("atomic human approval", () => {
  it.each(["refund", "store_credit", "exchange"] as const)("completes %s with a conditional label", async resolution => {
    for (const returnRequired of [true, false]) {
      const f = await approvalFixture(db, resolution, returnRequired);
      const service = new ApprovalService(db, approvalClock, approvalIds);
      const result = await service.approve(f.command, f.human);
      expect(result).toMatchObject({ proposal: { status: "approved", version: 2 }, rma: { status: "completed" } });
      expect(await executionCounts(db, f.human.sessionId)).toEqual({
        rmas: 1, rma_items: 1, simulated_refunds: resolution === "refund" ? 1 : 0,
        store_credits: resolution === "store_credit" ? 1 : 0,
        inventory_reservations: resolution === "exchange" ? 1 : 0, return_labels: returnRequired ? 1 : 0,
      });
      expect(await service.approve(f.command, f.human)).toEqual(result);
      const retryKey = approvalIds.next("retry");
      expect(await service.approve({ ...f.command, idempotencyKey: retryKey }, f.human)).toEqual(result);
      await expect(service.approve({ ...f.command, expectedVersion: 2, idempotencyKey: retryKey }, f.human))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      const variant = await db.prepare("SELECT inventory_quantity AS quantity, inventory_version AS version FROM product_variants WHERE session_id = ? AND id = ?")
        .bind(f.human.sessionId, f.facts.replacementId).first();
      expect(variant).toEqual({ quantity: resolution === "exchange" ? 0 : 1, version: resolution === "exchange" ? 2 : 1 });
    }
  });

  it("rejects agent actors, missing confirmation, version conflicts and cross-session IDs", async () => {
    const f = await approvalFixture(db);
    const other = await approvalFixture(db);
    const service = new ApprovalService(db, approvalClock, approvalIds);
    await expect(service.approve(f.command, { ...f.human, actor: { type: "agent", id: "agent" } } as never))
      .rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
    await expect(service.approve({ ...f.command, confirmation: "yes" } as never, f.human))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(service.approve({ ...f.command, expectedVersion: 9 }, f.human))
      .rejects.toMatchObject({ code: "ENTITY_VERSION_CONFLICT" });
    await expect(service.approve(f.command, other.human)).rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
    expect((await executionCounts(db, f.human.sessionId)).rmas).toBe(0);
  });

  it("rejects reuse of an approval key with changed payload", async () => {
    const f = await approvalFixture(db);
    const service = new ApprovalService(db, approvalClock, approvalIds);
    await service.approve(f.command, f.human);
    await expect(service.approve({ ...f.command, expectedVersion: 2 }, f.human))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it.each([
    ["RETURN_QUANTITY_UNAVAILABLE", "refund"],
    ["EXCHANGE_INVENTORY_UNAVAILABLE", "exchange"],
  ] as const)("commits invalidation for changed business fact %s without execution artifacts", async (reason, resolution) => {
    const f = await approvalFixture(db, resolution);
    if (reason === "RETURN_QUANTITY_UNAVAILABLE") {
      await db.prepare("UPDATE order_items SET previously_returned_quantity = fulfilled_quantity WHERE session_id = ? AND id = ?")
        .bind(f.human.sessionId, f.facts.orderItemId).run();
    } else {
      await db.prepare("UPDATE product_variants SET inventory_quantity = 0, inventory_version = inventory_version + 1 WHERE session_id = ? AND id = ?")
        .bind(f.human.sessionId, f.facts.replacementId).run();
    }
    const service = new ApprovalService(db, approvalClock, approvalIds);
    const first = await service.approve(f.command, f.human);
    expect(first).toMatchObject({ proposal: { status: "invalidated", version: 2, invalidatedReasonCode: reason }, rma: null });
    expect(await service.approve(f.command, f.human)).toEqual(first);
    expect(Object.values(await executionCounts(db, f.human.sessionId))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await db.prepare("SELECT actor_type, metadata_json FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.invalidated'")
      .bind(f.human.sessionId).first()).toMatchObject({ actor_type: "system" });
  });

  it("leaves pending when invalidation itself encounters a technical failure", async () => {
    const f = await approvalFixture(db, "exchange");
    await db.prepare("UPDATE product_variants SET inventory_quantity = 0 WHERE session_id = ? AND id = ?")
      .bind(f.human.sessionId, f.facts.replacementId).run();
    await db.prepare(`CREATE TRIGGER fail_invalidation BEFORE UPDATE OF status ON rma_proposals
      WHEN NEW.status = 'invalidated' BEGIN SELECT RAISE(ABORT, 'simulated technical failure'); END`).run();
    try {
      await expect(new ApprovalService(db, approvalClock, approvalIds).approve(f.command, f.human))
        .rejects.toMatchObject({ code: "APPROVAL_TRANSACTION_FAILED", httpStatus: 503 });
    } finally {
      await db.prepare("DROP TRIGGER fail_invalidation").run();
    }
    expect(await db.prepare("SELECT status, version FROM rma_proposals WHERE session_id = ? AND id = ?")
      .bind(f.human.sessionId, f.proposal.proposalId).first()).toEqual({ status: "pending", version: 1 });
    expect(Object.values(await executionCounts(db, f.human.sessionId))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rolls back after every statement in every branch and permits same-key retry", async () => {
    for (const resolution of ["refund", "store_credit", "exchange"] as const) {
      const f = await approvalFixture(db, resolution);
      let count = 0;
      const run = (failAfter: number) => new ApprovalService(db, approvalClock, approvalIds, {
        transformBatch(statements) {
          count = statements.length;
          return [...statements.slice(0, failAfter), db.prepare(
            "UPDATE product_variants SET inventory_quantity = -1 WHERE session_id = ?",
          ).bind(f.human.sessionId), ...statements.slice(failAfter)];
        },
      }).approve(f.command, f.human);
      await expect(run(1)).rejects.toMatchObject({ code: "APPROVAL_TRANSACTION_FAILED", httpStatus: 503 });
      for (let position = 2; position <= count; position++) {
        await expect(run(position)).rejects.toMatchObject({ code: "APPROVAL_TRANSACTION_FAILED" });
        expect(Object.values(await executionCounts(db, f.human.sessionId))).toEqual([0, 0, 0, 0, 0, 0]);
        expect(await db.prepare("SELECT status, version FROM rma_proposals WHERE session_id = ? AND id = ?")
          .bind(f.human.sessionId, f.proposal.proposalId).first()).toEqual({ status: "pending", version: 1 });
        expect(await db.prepare("SELECT previously_returned_quantity AS n FROM order_items WHERE session_id = ? AND id = ?")
          .bind(f.human.sessionId, f.facts.orderItemId).first()).toEqual({ n: 0 });
        expect(await db.prepare("SELECT inventory_quantity AS n FROM product_variants WHERE session_id = ? AND id = ?")
          .bind(f.human.sessionId, f.facts.replacementId).first()).toEqual({ n: 1 });
        expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE session_id = ? AND event_type = 'rma_proposal.approved'")
          .bind(f.human.sessionId).first()).toEqual({ n: 0 });
      }
      await expect(new ApprovalService(db, approvalClock, approvalIds).approve(f.command, f.human))
        .resolves.toMatchObject({ proposal: { status: "approved" } });
    }
  }, 30_000);
});
