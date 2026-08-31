import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnvironment } from "../http/context";
import type { Clock, IdGenerator } from "../domain/primitives";
import { routeKit } from "./shared";
import { dashboardRoutes } from "./dashboard";
import { orderRoutes } from "./orders";
import { caseRoutes } from "./cases";
import { eligibilityRoutes } from "./eligibility";
import { proposalRoutes } from "./proposals";
import { policyRoutes } from "./policies";
import { sessionRoutes } from "./session";
export function apiRoutes(db: D1Database, clock: Clock, ids: IdGenerator, csrf: MiddlewareHandler<AppEnvironment>, signingKey: string) {
  const app = new Hono<AppEnvironment>();
  const kit = routeKit(app, db, clock, ids, csrf);
  dashboardRoutes(kit); orderRoutes(kit); caseRoutes(kit); eligibilityRoutes(kit); proposalRoutes(kit); policyRoutes(kit); sessionRoutes(kit, signingKey);
  return app;
}
