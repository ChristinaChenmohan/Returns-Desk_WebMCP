import { describe, expect, it } from "vitest";
import { ApprovalService } from "../../worker/domain/approval-service";
import { ResetService } from "../../worker/demo/reset-service";
import { approvalClock, approvalFixture, approvalIds, executionCounts } from "../fixtures/approval";
import { db } from "./setup";

describe("approval races", () => {
  it("returns the same RMA for simultaneous duplicate approvals", async () => {
    const f = await approvalFixture(db, "exchange");
    const service = new ApprovalService(db, approvalClock, approvalIds);
    const results = await Promise.all([service.approve(f.command, f.human), service.approve(f.command, f.human)]);
    expect(results[0]).toEqual(results[1]);
    expect((await executionCounts(db, f.human.sessionId)).inventory_reservations).toBe(1);
  });

  it.each(["refund", "exchange"] as const)("prevents two %s approvals consuming the final returnable unit", async resolution => {
    const f = await approvalFixture(db, resolution);
    const second = await f.createProposal();
    const service = new ApprovalService(db, approvalClock, approvalIds);
    const results = await Promise.all([
      service.approve(f.command, f.human),
      service.approve({ ...f.command, proposalId: second.proposalId, idempotencyKey: approvalIds.next("approve") }, f.human),
    ]);
    expect(results.filter(result => result.proposal.status === "approved")).toHaveLength(1);
    expect(results.filter(result => result.proposal.status === "invalidated")).toHaveLength(1);
    expect((await executionCounts(db, f.human.sessionId)).rmas).toBe(1);
  });

  it("does not write anything after a Reset between validation and batch", async () => {
    const f = await approvalFixture(db);
    const service = new ApprovalService(db, approvalClock, approvalIds, {
      async beforeBatch() {
        await new ResetService(db, approvalClock, approvalIds).reset({
          sessionId: f.human.sessionId, expectedSeedVersion: 1, idempotencyKey: "reset-approval",
        });
      },
    });
    await expect(service.approve(f.command, f.human)).rejects.toMatchObject({ code: "DEMO_SESSION_RESET" });
    expect(Object.values(await executionCounts(db, f.human.sessionId))).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
