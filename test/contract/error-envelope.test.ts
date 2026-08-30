import { describe, expect, it } from "vitest";

import { createApp } from "../../worker/app";
import type { DemoSession } from "../../worker/repositories/session-repository";
import { createSequentialIds, fixedClock } from "../fixtures/runtime";

const SESSION: DemoSession = {
  id: "session_error_test",
  createdAt: "2026-08-29T07:00:00.000Z",
  expiresAt: "2026-08-30T07:00:00.000Z",
  seedVersion: 3,
  resetCount: 0,
};

function createErrorApp() {
  return createApp({
    sessionRepository: { async getOrCreate() { return SESSION; } },
    channelSigningKey: "test-channel-signing-key-with-at-least-32-bytes",
    clock: fixedClock,
    ids: createSequentialIds(),
    allowedOrigin: "https://returns.test",
    enableTestRoutes: true,
  });
}

describe("HTTP error envelopes", () => {
  it("returns health in the stable success envelope", async () => {
    const response = await createErrorApp().request("/api/v1/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { status: "ok" },
      meta: {
        requestId: "req_1",
        serverTime: "2026-08-29T07:00:00.000Z",
        seedVersion: 0,
      },
    });
  });

  it("maps a DomainError to the exact safe envelope", async () => {
    const response = await createErrorApp().request("/api/v1/test-error/domain");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "PENDING_PROPOSAL_CONFLICT",
        message: "This case already has a pending proposal.",
        retryable: false,
        correlationId: "req_1",
        currentState: "pending",
        recoveryAction: "open_existing_proposal",
        fieldErrors: [],
      },
      meta: {
        requestId: "req_1",
        serverTime: "2026-08-29T07:00:00.000Z",
        seedVersion: 0,
      },
    });
  });

  it("maps an unknown exception without leaking its text", async () => {
    const response = await createErrorApp().request("/api/v1/test-error/unknown");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        retryable: false,
        correlationId: "req_1",
        fieldErrors: [],
      },
      meta: {
        requestId: "req_1",
        serverTime: "2026-08-29T07:00:00.000Z",
        seedVersion: 0,
      },
    });
    expect(JSON.stringify(body)).not.toContain("database password");
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
  });
});
