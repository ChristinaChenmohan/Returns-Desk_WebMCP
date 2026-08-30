import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { Clock, IdGenerator } from "../domain/primitives";
import type { DemoSession } from "../repositories/session-repository";
import type { Capability } from "./capability";

export type Actor = {
  type: "agent" | "human" | "system";
  id: string;
};

export type RequestContext = {
  sessionId: string;
  seedVersion: number;
  csrfToken: string;
  actor: Actor;
  requestId: string;
};

export type RequestVariables = {
  requestContext: RequestContext;
  session: DemoSession;
  capabilities: ReadonlySet<Capability>;
  parsedBody: Record<string, unknown>;
};

export type AppEnvironment = { Variables: RequestVariables };

export function createRequestContextMiddleware(_clock: Clock, ids: IdGenerator) {
  return createMiddleware<AppEnvironment>(async (c, next) => {
    c.set("requestContext", {
      sessionId: "",
      seedVersion: 0,
      csrfToken: "",
      actor: { type: "system", id: "system:http" },
      requestId: ids.next("req"),
    });
    await next();
  });
}

export function getRequestContext(c: Context<AppEnvironment>): RequestContext {
  return c.get("requestContext");
}
