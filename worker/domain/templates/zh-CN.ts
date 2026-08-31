import type { TemplateFacts, MessageTone } from "./en-US";

export function renderZhCn(facts: TemplateFacts, tone: MessageTone): { subject: string; bodyText: string } {
  const opening = tone === "apologetic"
    ? `${facts.CUSTOMER_NAME}，很抱歉本次订单未能符合您的预期。`
    : `${facts.CUSTOMER_NAME}，您好：`;
  const returnInstruction = facts.RETURN_REQUIRED
    ? "请按照 Returns Desk 中显示的说明寄回商品。"
    : "您无需寄回商品。";
  return {
    subject: `订单 ${facts.ORDER_NUMBER} 的退货申请`,
    bodyText: `${opening}\n\n我们已确认订单 ${facts.ORDER_NUMBER} 的${resolutionLabel(facts.RESOLUTION)}方案。${returnInstruction}\n\n此消息仅为草稿，尚未发送。`,
  };
}

function resolutionLabel(resolution: TemplateFacts["RESOLUTION"]): string {
  if (resolution === "exchange") return "换货";
  if (resolution === "store_credit") return "商店余额";
  return "退款";
}
