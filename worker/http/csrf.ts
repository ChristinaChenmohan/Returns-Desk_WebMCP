import { createMiddleware } from "hono/factory";

import { DomainError } from "../domain/errors";
import type { Clock } from "../domain/primitives";
import type { AppEnvironment } from "./context";

const CSRF_LIFETIME_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();

type CsrfPayload = {
  version: 1;
  sessionId: string;
  seedVersion: number;
  expiresAt: number;
};

type IssueCsrfTokenInput = {
  signingKey: string;
  sessionId: string;
  seedVersion: number;
  now: Date;
};

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("malformed csrf token");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function keyFor(signingKey: string, usage: KeyUsage): Promise<CryptoKey> {
  if (encoder.encode(signingKey).byteLength < 32) throw new Error("signing key is too short");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function validPayload(value: unknown): value is CsrfPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 4 &&
    candidate.version === 1 &&
    typeof candidate.sessionId === "string" &&
    Number.isInteger(candidate.seedVersion) &&
    typeof candidate.expiresAt === "number" &&
    Number.isInteger(candidate.expiresAt)
  );
}

export async function issueCsrfToken(input: IssueCsrfTokenInput): Promise<string> {
  const payload: CsrfPayload = {
    version: 1,
    sessionId: input.sessionId,
    seedVersion: input.seedVersion,
    expiresAt: input.now.getTime() + CSRF_LIFETIME_MS,
  };
  const encodedPayload = encode(encoder.encode(JSON.stringify(payload)));
  const key = await keyFor(input.signingKey, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return `${encodedPayload}.${encode(new Uint8Array(signature))}`;
}

async function verifyCsrfToken(
  token: string,
  signingKey: string,
  sessionId: string,
  seedVersion: number,
  now: Date,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return false;

  try {
    const key = await keyFor(signingKey, "verify");
    const signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      decode(parts[1]),
      encoder.encode(parts[0]),
    );
    if (!signatureValid) return false;

    const parsed: unknown = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    return (
      validPayload(parsed) &&
      parsed.expiresAt > now.getTime() &&
      parsed.sessionId === sessionId &&
      parsed.seedVersion === seedVersion
    );
  } catch {
    return false;
  }
}

function requestIsSameOrigin(
  requestUrl: string,
  origin: string | undefined,
  referer: string | undefined,
  allowedOrigin?: string,
): boolean {
  const expectedOrigin = allowedOrigin ?? new URL(requestUrl).origin;
  if (origin !== undefined) return origin === expectedOrigin;
  if (referer === undefined) return false;

  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}

export function requireCsrf(signingKey: string, clock: Clock, allowedOrigin?: string) {
  return createMiddleware<AppEnvironment>(async (c, next) => {
    const context = c.get("requestContext");
    const token = c.req.header("x-csrf-token");
    const sameOrigin = requestIsSameOrigin(
      c.req.url,
      c.req.header("origin"),
      c.req.header("referer"),
      allowedOrigin,
    );
    const tokenValid =
      token !== undefined &&
      (await verifyCsrfToken(
        token,
        signingKey,
        context.sessionId,
        context.seedVersion,
        clock.now(),
      ));

    if (!sameOrigin || !tokenValid) throw new DomainError("FORBIDDEN", 403, false);

    c.set("requestContext", { ...context, csrfToken: token });
    await next();
  });
}
