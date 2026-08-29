import { z } from "zod";
import { conditionCode, reasonCode, resolutionType } from "./common";

const entityId = z.string().min(1).max(64);
const idempotencyKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export const toolNames = [
  "search_orders",
  "get_return_policy",
  "check_return_eligibility",
  "compare_resolution_options",
  "draft_customer_message",
  "submit_rma_for_approval",
] as const;

export type ToolName = (typeof toolNames)[number];

export const searchOrdersInput = z.object({
  query: z.string().min(2).max(120),
  limit: z.number().int().min(1).max(5).default(5),
}).strict();

export const getReturnPolicyInput = z.object({
  orderId: entityId,
  orderItemId: entityId,
}).strict();

export const checkEligibilityInput = z.object({
  caseId: entityId.optional(),
  orderId: entityId,
  orderItemId: entityId,
  requestedQuantity: z.number().int().min(1).max(100),
  reasonCode,
  conditionCode,
  replacementVariantId: entityId.optional(),
  storeCreditConsent: z.boolean().optional(),
  customerNote: z.string().max(1000).optional(),
  idempotencyKey,
}).strict();

export const compareResolutionOptionsInput = z.object({
  eligibilityCheckId: entityId,
  preference: z.enum(["customer_value", "merchant_cost", "fastest_resolution"]).default("customer_value"),
}).strict();

export const draftCustomerMessageInput = z.object({
  caseId: entityId,
  eligibilityCheckId: entityId,
  resolutionType,
  replacementVariantId: entityId.optional(),
  tone: z.enum(["concise", "warm", "apologetic"]).default("warm"),
  locale: z.enum(["en-US", "zh-CN"]),
}).strict();

export const submitProposalInput = z.object({
  caseId: entityId,
  eligibilityCheckId: entityId,
  resolutionType,
  replacementVariantId: entityId.optional(),
  customerMessage: z.object({
    subject: z.string().min(1).max(160),
    bodyText: z.string().min(1).max(4000),
    locale: z.enum(["en-US", "zh-CN"]),
  }).strict(),
  idempotencyKey,
}).strict();

export type SearchOrdersInput = z.infer<typeof searchOrdersInput>;
export type GetReturnPolicyInput = z.infer<typeof getReturnPolicyInput>;
export type CheckEligibilityInput = z.infer<typeof checkEligibilityInput>;
export type CompareResolutionOptionsInput = z.infer<typeof compareResolutionOptionsInput>;
export type DraftCustomerMessageInput = z.infer<typeof draftCustomerMessageInput>;
export type SubmitProposalInput = z.infer<typeof submitProposalInput>;
