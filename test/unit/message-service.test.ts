import { describe, expect, it } from "vitest";

import { MessageService, type MessageFacts } from "../../worker/domain/message-service";

const request = {
  caseId: "case_1",
  eligibilityCheckId: "check_1",
  resolutionType: "refund" as const,
  tone: "warm" as const,
  locale: "en-US" as const,
};

const facts: MessageFacts = {
  CUSTOMER_NAME: "Avery",
  ORDER_NUMBER: "ORD-1001",
  RESOLUTION: "refund",
  RETURN_REQUIRED: true,
};

describe("MessageService", () => {
  it("returns empty text and explicit missing facts rather than inventing content", async () => {
    const service = new MessageService({ resolve: async () => ({ ...facts, CUSTOMER_NAME: undefined }) });
    expect(await service.draft(request, { sessionId: "session_1", actor: { type: "agent", id: "agent:1" } })).toEqual({
      subject: "",
      bodyText: "",
      factsUsed: [],
      missingInformation: ["CUSTOMER_NAME"],
      sendStatus: "not_sent",
    });
  });

  it.each(["en-US", "zh-CN"] as const)("renders controlled %s plain-text templates", async locale => {
    const service = new MessageService({ resolve: async () => facts });
    const result = await service.draft({ ...request, locale }, {
      sessionId: "session_1", actor: { type: "agent", id: "agent:1" },
    });
    expect(result.subject).toContain("ORD-1001");
    expect(result.bodyText).toContain("Avery");
    expect(result.factsUsed).toEqual(["CUSTOMER_NAME", "ORDER_NUMBER", "RESOLUTION", "RETURN_REQUIRED"]);
    expect(result.missingInformation).toEqual([]);
    expect(result.sendStatus).toBe("not_sent");
  });

  it.each(["en-US", "zh-CN"] as const)(
    "prevents fact-controlled line and paragraph injection in %s",
    async locale => {
      const service = new MessageService({
        resolve: async () => ({
          ...facts,
          CUSTOMER_NAME: "Avery\r\nBcc: attacker@example.test\tVIP\u2028next\u2029paragraph",
          ORDER_NUMBER: "ORD-1001\r\nInjected-Header\tvalue\u2028more\u2029end",
        }),
      });
      const result = await service.draft({ ...request, locale }, {
        sessionId: "session_1", actor: { type: "agent", id: "agent:1" },
      });

      expect(result.subject).not.toMatch(/[\r\n\t\u2028\u2029]/u);
      expect(result.bodyText).not.toMatch(/[\r\t\u2028\u2029]/u);
      expect(result.bodyText.split("\n\n")).toHaveLength(3);
      expect(result.bodyText).toContain("Avery Bcc: attacker@example.test VIP next paragraph");
      expect(result.subject).toContain("ORD-1001 Injected-Header value more end");
    },
  );

  it("neutralizes markup-like fact values and writes only a minimal audit summary", async () => {
    const recorded: unknown[] = [];
    const service = new MessageService(
      { resolve: async () => ({ ...facts, CUSTOMER_NAME: "<img src=x onerror=alert(1)>" }) },
      { append: async event => { recorded.push(event); } },
    );
    const result = await service.draft(request, {
      sessionId: "session_1", actor: { type: "agent", id: "agent:1" },
    });
    expect(result.bodyText).not.toContain("<img");
    expect(recorded).toEqual([{
      sessionId: "session_1",
      caseId: "case_1",
      actorType: "agent",
      actorId: "agent:1",
      eventType: "message.drafted",
      entityType: "eligibility_check",
      entityId: "check_1",
      summary: "Drafted a customer message.",
      metadata: { locale: "en-US", resolutionType: "refund" },
    }]);
    expect(JSON.stringify(recorded)).not.toContain("ORD-1001");
    expect(JSON.stringify(recorded)).not.toContain("img src");
  });
});
