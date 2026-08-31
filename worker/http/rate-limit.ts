import { DomainError } from "../domain/errors";
export type RateLimitKind = "search" | "eligibility" | "write";
export const RATE_LIMITS: Readonly<Record<RateLimitKind, number>> = { search: 60, eligibility: 30, write: 60 };
export async function rateLimitDigest(sessionId: string, ip: string): Promise<string> {
  // IPv4 /24 or IPv6 /48 only; neither raw IP nor session is persisted in the digest.
  const coarse = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip.split(".").slice(0, 3).join(".") : ip.includes(":") ? ip.split(":").slice(0, 3).join(":") : "unknown";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${sessionId}\0${coarse}`));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function consumeRateLimit(db: D1Database, kind: RateLimitKind, digest: string, now: Date, sessionId: string): Promise<void> {
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const row = await db.prepare(`INSERT INTO rate_limit_buckets (bucket_kind, subject_digest, session_id, window_started_at, request_count)
    VALUES (?, ?, ?, ?, 1) ON CONFLICT(bucket_kind, subject_digest) DO UPDATE SET
    request_count = CASE WHEN window_started_at = excluded.window_started_at THEN MIN(request_count + 1, 1000000) ELSE 1 END,
    window_started_at = excluded.window_started_at RETURNING request_count`)
    .bind(kind, digest, sessionId, window).first<{ request_count: number }>();
  if (!row || row.request_count > RATE_LIMITS[kind]) throw new DomainError("RATE_LIMITED", 429, true, "retry_after_60_seconds");
}
