import type { ProposalStatus } from "../../src/shared/contracts/common";
import { DomainError } from "./errors";

const TERMINAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "approved",
  "rejected",
  "expired",
  "superseded",
  "invalidated",
]);

export function transitionProposal(
  current: ProposalStatus,
  next: ProposalStatus,
): ProposalStatus {
  if (current !== "pending") {
    throw new DomainError(
      "PROPOSAL_NOT_PENDING",
      409,
      false,
      "refresh_proposal",
      current,
    );
  }
  if (!TERMINAL_STATUSES.has(next)) {
    throw new DomainError(
      "INVALID_STATE_TRANSITION",
      409,
      false,
      "refresh_proposal",
      current,
    );
  }
  return next;
}
