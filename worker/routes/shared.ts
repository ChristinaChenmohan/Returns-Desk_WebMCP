import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnvironment } from "../http/context";
import { requireCapability, type Capability } from "../http/capability";
import { DomainError } from "../domain/errors";
import type { Clock, IdGenerator } from "../domain/primitives";
import type { HumanContext } from "../domain/proposal-service";
import type { EffectRef } from "../../src/shared/contracts/common";
import { successEnvelope } from "../http/envelope";

export const id = z.string().min(1).max(64);
export const version = z.number().int().positive();
export const keySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
export const pageSchema = z.object({ cursor: z.string().min(1).max(512).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict();
export type ApiContext = Context<AppEnvironment>;
export type Handler = (c: ApiContext) => Promise<Response> | Response;
export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new DomainError("INVALID_REQUEST", 400, false, "correct_input");
  return result.data;
}
export function human(c: ApiContext): HumanContext {
  const context = c.get("requestContext");
  if (context.actor.type !== "human") throw new DomainError("FORBIDDEN", 403, false);
  return { ...context, actor: { type: "human", id: context.actor.id } };
}
export function params(c: ApiContext, name: string): string { return parse(id, c.req.param(name)); }
export function query(c: ApiContext): Record<string, string> {
  const entries = [...new URL(c.req.url).searchParams.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new DomainError("INVALID_REQUEST", 400, false);
  return Object.fromEntries(entries);
}
export function command<T>(c: ApiContext, schema: z.ZodType<T>, path: Record<string, string> = {}, keyed = true): T {
  const { expectedSeedVersion: _seed, ...body } = c.get("parsedBody");
  if (Object.keys(path).some(key => key in body)) throw new DomainError("INVALID_REQUEST", 400, false);
  return parse(schema, { ...body, ...path, ...(keyed ? { idempotencyKey: parse(keySchema, c.req.header("idempotency-key")) } : {}) });
}
export interface RouteKit {
  app: Hono<AppEnvironment>; db: D1Database; clock: Clock; ids: IdGenerator;
  get(path: string, capability: Capability, handler: Handler): void;
  write(method: "post" | "patch", path: string, capability: Capability, handler: Handler): void;
  ok(c: ApiContext, data: unknown, effects?: readonly EffectRef[], status?: number): Response;
  created(c: ApiContext, kind: string): Promise<number>;
}
export function routeKit(app: Hono<AppEnvironment>, db: D1Database, clock: Clock, ids: IdGenerator, csrf: MiddlewareHandler<AppEnvironment>): RouteKit {
  return {
    app, db, clock, ids,
    get: (path, capability, handler) => { app.get(path, requireCapability(capability), handler); },
    write: (method, path, capability, handler) => {
      app[method](path, requireCapability(capability), csrf, async (c, next) => {
        if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") throw new DomainError("INVALID_REQUEST", 400, false);
        if (Number(c.req.header("content-length")) > 65536) throw new DomainError("INVALID_REQUEST", 400, false);
        const text = await c.req.text();
        if (new TextEncoder().encode(text).length > 65536) throw new DomainError("INVALID_REQUEST", 400, false);
        let body: unknown;
        try { body = JSON.parse(text); } catch { throw new DomainError("INVALID_REQUEST", 400, false); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("INVALID_REQUEST", 400, false);
        const record = body as Record<string, unknown>;
        parse(version, record.expectedSeedVersion);
        if (record.expectedSeedVersion !== c.get("requestContext").seedVersion) throw new DomainError("DEMO_SESSION_RESET", 409, false, "reload_demo");
        // HTTP owns the idempotency header; a conflicting body key is never silently accepted.
        if ("idempotencyKey" in record || "actorType" in record) throw new DomainError("INVALID_REQUEST", 400, false);
        c.set("parsedBody", record);
        await next();
      }, handler);
    },
    ok: (c, data, effects, status = 200) => Response.json({ ...successEnvelope(data, c.get("requestContext"), clock.now()),
      ...(effects === undefined ? {} : { effects }) }, { status }),
    created: async (c, kind) => {
      const row = await db.prepare("SELECT 1 FROM idempotency_records WHERE session_id = ? AND command_kind = ? AND idempotency_key = ?")
        .bind(c.get("requestContext").sessionId, kind, parse(keySchema, c.req.header("idempotency-key"))).first();
      return row === null ? 201 : 200;
    },
  };
}
export function caseEffect(caseId: string, entityVersion: number): EffectRef[] {
  return [{ entityType: "return_case", entityId: caseId, caseId, entityVersion }];
}
