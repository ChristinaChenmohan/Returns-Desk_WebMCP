import { z } from "zod";

export const reasonCode = z.enum([
  "changed_mind",
  "wrong_size",
  "damaged",
  "wrong_item",
  "not_as_described",
]);

export const conditionCode = z.enum(["unopened", "opened_unused", "used", "damaged"]);

export const resolutionType = z.enum(["exchange", "refund", "store_credit"]);

export const eligibilityStatus = z.enum(["eligible", "ineligible", "needs_review"]);

export const proposalStatus = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "superseded",
  "invalidated",
]);

export type ReasonCode = z.infer<typeof reasonCode>;
export type ConditionCode = z.infer<typeof conditionCode>;
export type ResolutionType = z.infer<typeof resolutionType>;
export type EligibilityStatus = z.infer<typeof eligibilityStatus>;
export type ProposalStatus = z.infer<typeof proposalStatus>;

export type EffectRef = {
  entityType: string;
  entityId: string;
  entityVersion: number;
  caseId?: string;
};
