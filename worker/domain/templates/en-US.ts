import type { ResolutionType } from "../../../src/shared/contracts/common";

export interface TemplateFacts {
  CUSTOMER_NAME: string;
  ORDER_NUMBER: string;
  RESOLUTION: ResolutionType;
  RETURN_REQUIRED: boolean;
}

export type MessageTone = "concise" | "warm" | "apologetic";

export function renderEnUs(facts: TemplateFacts, tone: MessageTone): { subject: string; bodyText: string } {
  const opening = tone === "apologetic"
    ? `We're sorry this order did not work out, ${facts.CUSTOMER_NAME}.`
    : tone === "concise"
      ? `Hello ${facts.CUSTOMER_NAME},`
      : `Hi ${facts.CUSTOMER_NAME},`;
  const returnInstruction = facts.RETURN_REQUIRED
    ? "Please return the item using the instructions shown in Returns Desk."
    : "You do not need to return the item.";
  return {
    subject: `Your return request for order ${facts.ORDER_NUMBER}`,
    bodyText: `${opening}\n\nWe confirmed your ${resolutionLabel(facts.RESOLUTION)} for order ${facts.ORDER_NUMBER}. ${returnInstruction}\n\nThis draft has not been sent.`,
  };
}

function resolutionLabel(resolution: ResolutionType): string {
  if (resolution === "store_credit") return "store credit";
  return resolution;
}
