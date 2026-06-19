import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request } from "express";

/**
 * Client IP used to key rate limiters. Requests reach this server through the
 * Replit reverse proxy, so the real client is in X-Forwarded-For. The app
 * deliberately does NOT enable Express `trust proxy` (it reads XFF explicitly,
 * mirroring getRequestIp in routes/emailTracking.ts), so we resolve the key the
 * same way and fall back to the socket address.
 */
function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real;
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * Abuse guard for the UNAUTHENTICATED, internet-reachable email-tracking
 * endpoints (register / search / status / delete-view). The Magio extension
 * speaks raw HTTP from mail.google.com with no Clerk session, so those routes
 * cannot be auth-gated; this caps scraping/abuse on them.
 *
 * Deliberately scoped, not global:
 *   - The tracking pixel is excluded — legitimate opens fire it constantly.
 *   - Auth-gated routes are excluded — behind the shared Replit proxy, many
 *     team members' authenticated traffic can collapse onto one source IP, so a
 *     global per-IP cap would throttle the whole org collectively. We key by IP
 *     here only because these specific routes are hit by external clients.
 */
export const publicTrackingLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIp,
  // We read XFF ourselves rather than enabling `trust proxy`, so disable the
  // library's proxy validation (it would otherwise warn/throw in this setup).
  validate: false,
  message: { error: "rate_limited", message: "Too many requests" },
});
