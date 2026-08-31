import { createMiddleware } from "hono/factory";

import type { Clock } from "../domain/primitives";
import type { SessionRepository } from "../repositories/session-repository";
import type { AppEnvironment } from "./context";
import { issueCsrfToken } from "./csrf";
import { DomainError } from "../domain/errors";

export const SESSION_COOKIE_NAME = "returns_desk_session";

type SessionReader = Pick<SessionRepository, "getOrCreate"> & Partial<Pick<SessionRepository, "getExisting">>;

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;

    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }

  return null;
}

function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/api/v1; HttpOnly; Secure; SameSite=Lax`;
}

export function createSessionMiddleware(
  repository: SessionReader,
  signingKey: string,
  clock: Clock,
  requireExisting = false,
) {
  return createMiddleware<AppEnvironment>(async (c, next) => {
    const cookieId = readCookie(c.req.header("cookie"), SESSION_COOKIE_NAME);
    if (requireExisting && cookieId === null) throw new DomainError("SESSION_EXPIRED", 401, false, "bootstrap_session");
    const session = requireExisting && repository.getExisting
      ? await repository.getExisting(cookieId!) : await repository.getOrCreate(cookieId);
    if (session === null || (requireExisting && session.id !== cookieId)) throw new DomainError("SESSION_EXPIRED", 401, false, "bootstrap_session");
    const csrfToken = await issueCsrfToken({
      signingKey,
      sessionId: session.id,
      seedVersion: session.seedVersion,
      now: clock.now(),
    });
    const current = c.get("requestContext");

    c.set("session", session);
    c.set("requestContext", {
      ...current,
      sessionId: session.id,
      seedVersion: session.seedVersion,
      csrfToken,
    });

    await next();
    if (cookieId !== session.id) c.header("Set-Cookie", sessionCookie(session.id));
  });
}
