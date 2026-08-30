import { createMiddleware } from "hono/factory";

import { DomainError } from "../domain/errors";
import type { Clock } from "../domain/primitives";
import { capabilitiesForChannel, type ChannelClass } from "./capability";
import type { AppEnvironment } from "./context";

const TOKEN_VERSION = 1;
const TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();

type ChannelTokenPayload = {
  version: number;
  channel: ChannelClass;
  sessionId: string;
  seedVersion: number;
  expiresAt: number;
};

export type IssueChannelTokenInput = {
  signingKey: string;
  channel: ChannelClass;
  sessionId: string;
  seedVersion: number;
  now: Date;
  expiresAt?: Date | undefined;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("malformed token");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function importHmacKey(signingKey: string, usage: KeyUsage): Promise<CryptoKey> {
  if (encoder.encode(signingKey).byteLength < 32) throw new Error("signing key is too short");

  return crypto.subtle.importKey(
    "raw",
    encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function isPayload(value: unknown): value is ChannelTokenPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 5 &&
    candidate.version === TOKEN_VERSION &&
    (candidate.channel === "human" || candidate.channel === "agent") &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    Number.isInteger(candidate.seedVersion) &&
    typeof candidate.expiresAt === "number" &&
    Number.isInteger(candidate.expiresAt)
  );
}

export async function issueChannelToken(input: IssueChannelTokenInput): Promise<string> {
  const payload: ChannelTokenPayload = {
    version: TOKEN_VERSION,
    channel: input.channel,
    sessionId: input.sessionId,
    seedVersion: input.seedVersion,
    expiresAt: (input.expiresAt ?? new Date(input.now.getTime() + TOKEN_LIFETIME_MS)).getTime(),
  };
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(input.signingKey, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encodedPayload));
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifyChannelToken(
  token: string,
  signingKey: string,
  sessionId: string,
  seedVersion: number,
  now: Date,
): Promise<ChannelTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;

  try {
    const key = await importHmacKey(signingKey, "verify");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(parts[1]),
      encoder.encode(parts[0]),
    );
    if (!valid) return null;

    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
    if (!isPayload(parsed)) return null;
    if (parsed.expiresAt <= now.getTime()) return null;
    if (parsed.sessionId !== sessionId || parsed.seedVersion !== seedVersion) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function requireChannelToken(signingKey: string, clock: Clock) {
  return createMiddleware<AppEnvironment>(async (c, next) => {
    const context = c.get("requestContext");
    const token = c.req.header("x-channel-token");
    const payload =
      token === undefined
        ? null
        : await verifyChannelToken(
            token,
            signingKey,
            context.sessionId,
            context.seedVersion,
            clock.now(),
          );

    if (payload === null) throw new DomainError("FORBIDDEN", 403, false);

    c.set("capabilities", capabilitiesForChannel(payload.channel));
    c.set("requestContext", {
      ...context,
      actor: { type: payload.channel, id: `${payload.channel}:${context.sessionId}` },
    });
    await next();
  });
}
