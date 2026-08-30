import { createMiddleware } from "hono/factory";

import type { AppEnvironment } from "./context";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export function securityHeaders() {
  return createMiddleware<AppEnvironment>(async (c, next) => {
    try {
      await next();
    } finally {
      c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "same-origin");
      c.header("X-Frame-Options", "DENY");
    }
  });
}
