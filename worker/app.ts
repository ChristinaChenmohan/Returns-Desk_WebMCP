import { Hono, type Context, type MiddlewareHandler } from "hono";

import { DomainError } from "./domain/errors";
import { cryptoIds, systemClock, type Clock, type IdGenerator } from "./domain/primitives";
import { CAPABILITY, capabilitiesForChannel, requireCapability, type Capability } from "./http/capability";
import { issueChannelToken, requireChannelToken } from "./http/channel-token";
import { createRequestContextMiddleware, type AppEnvironment } from "./http/context";
import { requireCsrf } from "./http/csrf";
import { jsonSuccess } from "./http/envelope";
import { mapError } from "./http/error-mapper";
import { securityHeaders } from "./http/security-headers";
import { createSessionMiddleware } from "./http/session";
import type { SessionRepository } from "./repositories/session-repository";
import { apiRoutes } from "./routes";
import { consumeRateLimit, rateLimitDigest } from "./http/rate-limit";
import { safeLog, type SafeLog } from "./http/safe-logger";

type SessionReader = Pick<SessionRepository, "getOrCreate"> & Partial<Pick<SessionRepository, "getExisting">>;

export type AppDependencies = {
  db?: D1Database;
  sessionRepository: SessionReader;
  channelSigningKey: string;
  clock?: Clock;
  ids?: IdGenerator;
  allowedOrigin?: string;
  assets?: Fetcher;
  enableTestRoutes?: boolean;
  logSink?: (entry: SafeLog) => void;
};

type TestWriteBody = {
  expectedSeedVersion: number;
  note?: string;
};

type JsonRouteDefinition = {
  path: string;
  capability: Capability;
  maxBodyBytes: number;
  maxStringLength: number;
  allowedFields: ReadonlySet<string>;
  handler: (c: Context<AppEnvironment>, body: TestWriteBody) => Response | Promise<Response>;
};

function invalidRequest(): DomainError {
  return new DomainError("INVALID_REQUEST", 400, false, "correct_input");
}

function parseJsonBody(definition: JsonRouteDefinition): MiddlewareHandler<AppEnvironment> {
  return async (c, next) => {
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw invalidRequest();

    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > definition.maxBodyBytes) {
      throw invalidRequest();
    }

    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).byteLength > definition.maxBodyBytes) throw invalidRequest();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidRequest();
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalidRequest();
    const body = parsed as Record<string, unknown>;
    if (Object.keys(body).some(field => !definition.allowedFields.has(field))) throw invalidRequest();
    if (!Number.isInteger(body.expectedSeedVersion) || (body.expectedSeedVersion as number) < 1) {
      throw invalidRequest();
    }
    if (
      body.note !== undefined &&
      (typeof body.note !== "string" || body.note.length > definition.maxStringLength)
    ) {
      throw invalidRequest();
    }

    c.set("parsedBody", body);
    await next();
  };
}

function requireExpectedSeedVersion(): MiddlewareHandler<AppEnvironment> {
  return async (c, next) => {
    const body = c.get("parsedBody");
    if (body.expectedSeedVersion !== c.get("requestContext").seedVersion) {
      throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
    }
    await next();
  };
}

export function createApp(dependencies: AppDependencies) {
  const clock = dependencies.clock ?? systemClock;
  const ids = dependencies.ids ?? cryptoIds;
  const app = new Hono<AppEnvironment>();
  const session = createSessionMiddleware(
    dependencies.sessionRepository,
    dependencies.channelSigningKey,
    clock,
  );
  const channel = requireChannelToken(dependencies.channelSigningKey, clock);
  const csrf = requireCsrf(dependencies.channelSigningKey, clock, dependencies.allowedOrigin);

  app.use("*", securityHeaders());
  app.use("*", createRequestContextMiddleware(clock, ids));
  app.use("/api/*", async (c, next) => {
    const started = performance.now(); await next();
    if (dependencies.logSink) safeLog({ requestId: c.get("requestContext").requestId, route: c.req.routePath, status: c.res.status, durationMs: performance.now() - started }, dependencies.logSink);
  });
  app.use("/api/*", async (c, next) => { await next(); c.header("Cache-Control", "no-store"); });

  app.onError((error, c) => {
    if (dependencies.logSink) safeLog({ requestId: c.get("requestContext").requestId, route: c.req.routePath, errorCode: error instanceof DomainError ? error.code : "INTERNAL_ERROR" }, dependencies.logSink);
    const response = mapError(error, c.get("requestContext"), clock.now());
    if (error instanceof DomainError && error.code === "RATE_LIMITED") response.headers.set("Retry-After", "60");
    return response;
  });

  app.get("/api/v1/health", c =>
    jsonSuccess({ status: "ok" }, c.get("requestContext"), clock.now()),
  );

  app.get("/api/v1/session/bootstrap", session, async c => {
    const context = c.get("requestContext");
    const humanChannelToken = await issueChannelToken({
      signingKey: dependencies.channelSigningKey,
      channel: "human",
      sessionId: context.sessionId,
      seedVersion: context.seedVersion,
      now: clock.now(),
    });

    const response = jsonSuccess(
      {
        csrfToken: context.csrfToken,
        humanChannelToken,
        seedVersion: context.seedVersion,
        capabilities: [...capabilitiesForChannel("human")],
      },
      context,
      clock.now(),
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  function registerJsonWrite(definition: JsonRouteDefinition) {
    app.post(
      definition.path,
      session,
      channel,
      parseJsonBody(definition),
      csrf,
      requireExpectedSeedVersion(),
      requireCapability(definition.capability),
      async c => definition.handler(c, c.get("parsedBody") as TestWriteBody),
    );
  }

  if (dependencies.enableTestRoutes === true) {
    const baseDefinition = {
      maxBodyBytes: 1_024,
      maxStringLength: 64,
      allowedFields: new Set(["expectedSeedVersion", "note"]),
      handler: (c: Context<AppEnvironment>) =>
        jsonSuccess(
          { actorType: c.get("requestContext").actor.type },
          c.get("requestContext"),
          clock.now(),
        ),
    };

    registerJsonWrite({
      ...baseDefinition,
      path: "/api/v1/test-write",
      capability: CAPABILITY.ELIGIBILITY_CHECK,
    });
    registerJsonWrite({
      ...baseDefinition,
      path: "/api/v1/test-human-approval",
      capability: CAPABILITY.PROPOSAL_APPROVE_HUMAN,
    });
    registerJsonWrite({
      ...baseDefinition,
      path: "/api/v1/test-agent-tool",
      capability: CAPABILITY.AGENT_TOOL_CHANNEL,
    });

    app.get("/api/v1/test-error/domain", () => {
      throw new DomainError(
        "PENDING_PROPOSAL_CONFLICT",
        409,
        false,
        "open_existing_proposal",
        "pending",
      );
    });
    app.get("/api/v1/test-error/unknown", () => {
      throw new Error("database password must never reach the response");
    });
  }

  if (dependencies.db) {
    const existingSession = createSessionMiddleware(dependencies.sessionRepository, dependencies.channelSigningKey, clock, true);
    app.get("/api/v1/session/agent-bootstrap", existingSession, async c => {
      const context = c.get("requestContext");
      return jsonSuccess({ seedVersion: context.seedVersion, csrfToken: context.csrfToken, agentChannelToken: await issueChannelToken({
        signingKey: dependencies.channelSigningKey, channel: "agent", sessionId: context.sessionId, seedVersion: context.seedVersion, now: clock.now(),
      }) }, context, clock.now());
    });
    app.use("/api/v1/*", existingSession, channel);
    const db = dependencies.db;
    app.use("/api/v1/*", async (c, next) => {
      const path = c.req.path;
      const kind = c.req.method === "GET" && path === "/api/v1/orders" ? "search" : c.req.method === "POST" && path === "/api/v1/eligibility-checks" ? "eligibility" : !["GET", "HEAD", "OPTIONS"].includes(c.req.method) ? "write" : null;
      if (kind) {
        const sessionId = c.get("requestContext").sessionId;
        await consumeRateLimit(db, kind, await rateLimitDigest(sessionId, c.req.header("CF-Connecting-IP") ?? "unknown"), clock.now(), sessionId);
      }
      await next();
    });
    app.route("/api/v1", apiRoutes(dependencies.db, clock, ids, csrf, dependencies.channelSigningKey));
  }
  app.all("/api/*", c => mapError(new DomainError("ENTITY_NOT_FOUND", 404, false), c.get("requestContext"), clock.now()));
  app.all("*", c => dependencies.assets?.fetch(c.req.raw) ?? new Response("Not Found", { status: 404 }));
  return app;
}
