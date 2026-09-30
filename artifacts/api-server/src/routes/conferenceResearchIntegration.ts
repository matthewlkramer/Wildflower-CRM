import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import { runConferenceResearchN8nTick } from "../lib/conferenceResearchN8n";
import { asyncHandler } from "../lib/helpers";

export const CONFERENCE_RESEARCH_INTEGRATION_PATH =
  "/integrations/conference-research/tick";
const TOKEN_ENV = "CONFERENCE_RESEARCH_N8N_AUTH_TOKEN";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function configuredToken(): string {
  return process.env[TOKEN_ENV]?.trim() ?? "";
}

export function hasValidConferenceResearchN8nToken(req: Request): boolean {
  const configured = configuredToken();
  const header = req.get("authorization")?.trim() ?? "";
  const supplied = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  if (!configured || !supplied) return false;
  return timingSafeEqual(digest(supplied), digest(configured));
}

const router: IRouter = Router();
const limiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.post(
  CONFERENCE_RESEARCH_INTEGRATION_PATH,
  limiter,
  asyncHandler(async (req, res) => {
    if (!configuredToken()) {
      res.status(503).json({ error: "conference_research_n8n_not_configured" });
      return;
    }
    if (!hasValidConferenceResearchN8nToken(req)) {
      res.setHeader(
        "WWW-Authenticate",
        'Bearer realm="wfcrm-conference-research"',
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const result = await runConferenceResearchN8nTick();
    res.status(result.status === "busy" ? 202 : 200).json(result);
  }),
);

export default router;
