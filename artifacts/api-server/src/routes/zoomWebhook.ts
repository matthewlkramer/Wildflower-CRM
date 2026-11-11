import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { ReceiveZoomWebhookBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { zoomCaptureAccount } from "../lib/zoomClient";

/**
 * Zoom event subscription endpoint for the WFCRM Server-to-Server OAuth app.
 *
 * Answers the validation challenge and verifies signed notifications. The
 * transcript worker handles Zoom API calls and note generation outside the
 * request. Payloads carry private information and are never logged.
 *
 * Authentication is Zoom's signature, not a user session: this router must be
 * mounted before the first sub-router that applies session auth at its module
 * root (see routes/index.ts).
 */
export const ZOOM_WEBHOOK_PATH = "/integrations/zoom/webhook";
/** Raw request bytes, captured by the JSON body parser for this path only (app.ts). */
export type RequestWithRawBody = Request & { rawBody?: Buffer };

// The secret is saved in Replit under the WFCRM-specific name (WFTLS has its own
// Zoom app and secrets); the plain name is accepted as a fallback.
const SECRET_ENVS = ["ZOOM_FORWFCRM_EVENTSUB_SECRET", "ZOOM_WEBHOOK_SECRET_TOKEN"];
/** Zoom signs `v0:{timestamp}:{raw body}`; reject anything older than this. */
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;

function configuredSecret(): string {
  for (const name of SECRET_ENVS) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

const hmacHex = (secret: string, message: string | Buffer): string =>
  createHmac("sha256", secret).update(message).digest("hex");

export function zoomValidationAnswer(plainToken: string, secret: string) {
  return { plainToken, encryptedToken: hmacHex(secret, plainToken) };
}

export function hasValidZoomSignature(
  headers: { signature: string | undefined; timestamp: string | undefined },
  rawBody: Buffer,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const { signature, timestamp } = headers;
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
  const expected = Buffer.from(
    `v0=${hmacHex(secret, Buffer.concat([Buffer.from(`v0:${timestamp}:`), rawBody]))}`,
  );
  const supplied = Buffer.from(signature);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const router: IRouter = Router();
const limiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.post(ZOOM_WEBHOOK_PATH, limiter, async (req: RequestWithRawBody, res) => {
  const secret = configuredSecret();
  if (!secret) {
    res.status(503).json({ error: "zoom_webhook_not_configured" });
    return;
  }
  const parsed = ReceiveZoomWebhookBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_zoom_event" });
    return;
  }
  const body = parsed.data;

  // Zoom's one-time (and periodic) check that we hold the secret token. It is
  // answered with an HMAC of the token Zoom sent, which only the secret holder
  // can produce.
  const plainToken = (body.payload as { plainToken?: unknown } | undefined)?.plainToken;
  if (body.event === "endpoint.url_validation" && typeof plainToken === "string" && plainToken) {
    res.json(zoomValidationAnswer(plainToken, secret));
    return;
  }

  const valid = req.rawBody && hasValidZoomSignature(
    { signature: req.get("x-zm-signature"), timestamp: req.get("x-zm-request-timestamp") },
    req.rawBody,
    secret,
  );
  if (!valid) {
    res.status(401).json({ error: "invalid_zoom_signature" });
    return;
  }

  if (!zoomCaptureAccount()) {
    res.json({ received: true });
    return;
  }
  try {
    const { enqueueZoomMeetingEvent, runZoomTranscriptJobs } = await import("../lib/zoomTranscripts");
    await enqueueZoomMeetingEvent(body.event, body.payload, body.event_ts);
    res.json({ received: true });
    void runZoomTranscriptJobs();
    return;
  } catch {
    logger.warn("Could not queue Zoom event");
    res.status(503).json({ error: "zoom_event_queue_unavailable" });
    return;
  }
});

export default router;
