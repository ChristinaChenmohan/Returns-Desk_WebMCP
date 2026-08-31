import { describe, expect, it } from "vitest";

import type { ProposalStatus } from "../../src/shared/contracts/common";
import { transitionProposal } from "../../worker/domain/proposal-transitions";

const terminals = ["approved", "rejected", "expired", "superseded", "invalidated"] as const;

describe("proposal transitions", () => {
  it.each(terminals)("allows pending to transition to %s", status => {
    expect(transitionProposal("pending", status)).toBe(status);
  });

  it.each(terminals)("does not revive %s", status => {
    expect(() => transitionProposal(status, "pending")).toThrowError(
      expect.objectContaining({ code: "PROPOSAL_NOT_PENDING", currentState: status }),
    );
  });

  it.each(terminals.flatMap(from => terminals.map(to => [from, to] as const)))(
    "does not transition terminal %s to %s",
    (from, to) => {
      expect(() => transitionProposal(from, to)).toThrowError(
        expect.objectContaining({ code: "PROPOSAL_NOT_PENDING", currentState: from }),
      );
    },
  );

  it("rejects pending-to-pending as an invalid transition", () => {
    expect(() => transitionProposal("pending", "pending" as ProposalStatus)).toThrowError(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION", currentState: "pending" }),
    );
  });
});
