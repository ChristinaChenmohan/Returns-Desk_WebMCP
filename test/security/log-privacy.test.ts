import { expect, it } from "vitest";
import { safeLog, type SafeLog } from "../../worker/http/safe-logger";
it("only emits allowed structured fields and drops credentials, customer content and exceptions", () => {
  const entries: SafeLog[] = [];
  safeLog({ requestId: "req_123", correlationId: "req_123", route: "/api/v1/cases/:caseId", status: 403, durationMs: 2.5, errorCode: "FORBIDDEN", entityType: "case", cookie: "secret", csrfToken: "secret", email: "a@example.test", note: "private", prompt: "ignore system", stack: "private stack", request: { headers: { Cookie: "secret" } } }, entry => entries.push(entry));
  expect(entries).toEqual([{ requestId: "req_123", correlationId: "req_123", route: "/api/v1/cases/:caseId", status: 403, durationMs: 3, errorCode: "FORBIDDEN", entityType: "case" }]);
  safeLog({ requestId: "a@example.test", route: "/orders?email=a@example.test", errorCode: "SQL error\nprivate" }, entry => entries.push(entry));
  expect(entries[1]).toEqual({});
});
