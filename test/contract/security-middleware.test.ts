import { describe, expect, it } from "vitest";

import { createApp } from "../../worker/app";
import { issueChannelToken } from "../../worker/http/channel-token";
import type { DemoSession } from "../../worker/repositories/session-repository";
import { createSequentialIds, fixedClock } from "../fixtures/runtime";

const SIGNING_KEY = "test-channel-signing-key-with-at-least-32-bytes";
const ORIGIN = "https://returns.test";
const SESSION: DemoSession = {
  id: "session_security_test",
  createdAt: "2026-08-29T07:00:00.000Z",
  expiresAt: "2026-08-30T07:00:00.000Z",
  seedVersion: 3,
  resetCount: 0,
};

function createTestApp() {
  return createApp({
    sessionRepository: {
      async getOrCreate(_cookieId: string | null) {
        return SESSION;
      },
    },
    channelSigningKey: SIGNING_KEY,
    clock: fixedClock,
    ids: createSequentialIds(),
    allowedOrigin: ORIGIN,
    enableTestRoutes: true,
  });
}

async function bootstrap(app = createTestApp()) {
  const response = await app.request("/api/v1/session/bootstrap");
  const rawBody = await response.text();
  const body = JSON.parse(rawBody) as {
    data: {
      csrfToken: string;
      humanChannelToken: string;
      seedVersion: number;
      capabilities: string[];
      agentChannelToken?: string;
      sessionId?: string;
    };
  };
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];

  if (cookie === undefined) {
    throw new Error(`bootstrap did not set a session cookie: ${response.status} ${rawBody}`);
  }

  return { app, response, cookie, ...body.data };
}

function writeRequest(
  credentials: Awaited<ReturnType<typeof bootstrap>>,
  overrides: {
    channelToken?: string;
    csrfToken?: string;
    origin?: string;
    path?: string;
    body?: string;
  } = {},
) {
  const headers = new Headers({
    cookie: credentials.cookie,
    "content-type": "application/json",
    "x-channel-token": overrides.channelToken ?? credentials.humanChannelToken,
  });

  if (overrides.csrfToken !== "") {
    headers.set("x-csrf-token", overrides.csrfToken ?? credentials.csrfToken);
  }
  if (overrides.origin !== "") {
    headers.set("origin", overrides.origin ?? ORIGIN);
  }

  return credentials.app.request(overrides.path ?? "/api/v1/test-write", {
    method: "POST",
    headers,
    body:
      overrides.body ??
      JSON.stringify({ expectedSeedVersion: SESSION.seedVersion, note: "safe note" }),
  });
}

async function agentToken(
  overrides: Partial<{
    sessionId: string;
    seedVersion: number;
    expiresAt: Date;
  }> = {},
) {
  return issueChannelToken({
    signingKey: SIGNING_KEY,
    channel: "agent",
    sessionId: overrides.sessionId ?? SESSION.id,
    seedVersion: overrides.seedVersion ?? SESSION.seedVersion,
    now: fixedClock.now(),
    expiresAt: overrides.expiresAt,
  });
}

describe("security middleware", () => {
  it("sets the secure session cookie and browser security headers", async () => {
    const { response } = await bootstrap();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(
      /returns_desk_session=[^;]+; Path=\/api\/v1; HttpOnly; Secure; SameSite=Lax/,
    );
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("gives the UI only the human channel token", async () => {
    const result = await bootstrap();

    expect(result.humanChannelToken).toEqual(expect.any(String));
    expect(result.agentChannelToken).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.capabilities).not.toContain("tools.channel.agent");
  });

  it.each([
    ["missing csrf", { csrfToken: "" }],
    ["invalid csrf", { csrfToken: "tampered" }],
    ["cross origin", { origin: "https://evil.test" }],
  ])("rejects %s", async (_name, overrides) => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, overrides);

    expect(response.status).toBe(403);
  });

  it("accepts a same-origin Referer only when Origin is absent", async () => {
    const credentials = await bootstrap();
    const headers = new Headers({
      cookie: credentials.cookie,
      "content-type": "application/json",
      "x-channel-token": credentials.humanChannelToken,
      "x-csrf-token": credentials.csrfToken,
      referer: `${ORIGIN}/cases/case_1`,
    });

    const response = await credentials.app.request("/api/v1/test-write", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedSeedVersion: SESSION.seedVersion, note: "safe note" }),
    });

    expect(response.status).toBe(200);
  });

  it("rejects a stale expected seed version", async () => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, {
      body: JSON.stringify({ expectedSeedVersion: 2, note: "safe note" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "DEMO_SESSION_RESET" } });
  });

  it("does not let an agent token call a human approval route", async () => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, {
      channelToken: await agentToken(),
      path: "/api/v1/test-human-approval?actorType=human&sessionId=session_security_test",
    });

    expect(response.status).toBe(403);
  });

  it("does not let a human token call the agent-only tool channel", async () => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, { path: "/api/v1/test-agent-tool" });

    expect(response.status).toBe(403);
  });

  it.each([
    ["tampered", async () => `${await agentToken()}tampered`],
    [
      "expired",
      () => agentToken({ expiresAt: new Date("2026-08-29T06:59:59.000Z") }),
    ],
    ["wrong session", () => agentToken({ sessionId: "session_other" })],
    ["wrong seed", () => agentToken({ seedVersion: 2 })],
  ])("rejects a %s channel token", async (_name, makeToken) => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, { channelToken: await makeToken() });

    expect(response.status).toBe(403);
  });

  it("derives the actor from a valid agent token", async () => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, { channelToken: await agentToken() });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { actorType: "agent" } });
  });

  it("strictly rejects client-supplied session and actor fields", async () => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, {
      body: JSON.stringify({
        expectedSeedVersion: SESSION.seedVersion,
        note: "safe note",
        sessionId: SESSION.id,
        actorType: "human",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects an overlong string before the route handler", async () => {
    const credentials = await bootstrap();

    const response = await writeRequest(credentials, {
      body: JSON.stringify({ expectedSeedVersion: SESSION.seedVersion, note: "x".repeat(65) }),
    });

    expect(response.status).toBe(400);
  });

  it("rejects an oversized body before the route handler", async () => {
    const credentials = await bootstrap();
    const body = `${JSON.stringify({ expectedSeedVersion: SESSION.seedVersion, note: "safe" })}${" ".repeat(1_100)}`;

    const response = await writeRequest(credentials, { body });

    expect(response.status).toBe(400);
  });
});
