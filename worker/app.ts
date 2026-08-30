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

type SessionReader = Pick<SessionRepository, "getOrCreate">;

export type AppDependencies = {
  sessionRepository: SessionReader;
  channelSigningKey: string;
  clock?: Clock;
  ids?: IdGenerator;
  allowedOrigin?: string;
  assets?: Fetcher;
  enableTestRoutes?: boolean;
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

  app.onError((error, c) => mapError(error, c.get("requestContext"), clock.now()));

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

  app.all("*", c => dependencies.assets?.fetch(c.req.raw) ?? new Response("Not Found", { status: 404 }));
  return app;
}
