import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { internalEmailDomains } from "@workspace/db/schema";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, parseOrBadRequest } from "../lib/helpers";
import { UpdateInternalEmailDomainsBody } from "@workspace/api-zod";
import {
  DEFAULT_INTERNAL_DOMAINS,
  invalidateInternalDomainsCache,
  invalidateStaffDefaultSuppressionCache,
} from "../lib/emailMatcher";

const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

function formatConfig(row: typeof internalEmailDomains.$inferSelect) {
  return {
    domains: row.domains,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Normalize a user-entered domain: lowercase, trim, strip a leading "@" or
// "*@" wildcard and any surrounding whitespace. Returns null for blanks.
function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (d.startsWith("*@")) d = d.slice(2);
  if (d.startsWith("@")) d = d.slice(1);
  d = d.trim();
  return d.length > 0 ? d : null;
}

router.get(
  "/internal-email-domains",
  asyncHandler(async (req, res) => {
    // Seed the singleton with the original two domains on first read so
    // behavior is unchanged on rollout.
    await db
      .insert(internalEmailDomains)
      .values({ id: "singleton", domains: [...DEFAULT_INTERNAL_DOMAINS] })
      .onConflictDoNothing();
    const row = await db
      .select()
      .from(internalEmailDomains)
      .then((r) => r[0]);
    if (!row) {
      res.json({
        domains: [...DEFAULT_INTERNAL_DOMAINS],
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    res.json(formatConfig(row));
  }),
);

router.put(
  "/internal-email-domains",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(UpdateInternalEmailDomainsBody, req.body, res);
    if (!body) return;

    // Normalize + dedupe (case-insensitive) while preserving input order.
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const raw of body.domains) {
      const d = normalizeDomain(raw);
      if (!d) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      domains.push(d);
    }

    await db
      .insert(internalEmailDomains)
      .values({ id: "singleton", domains })
      .onConflictDoUpdate({
        target: internalEmailDomains.id,
        set: { domains, updatedAt: new Date() },
      });
    const row = await db
      .select()
      .from(internalEmailDomains)
      .then((r) => r[0]);
    // Bust the matcher cache so sync picks up the change immediately. The
    // staff-default set is derived from these domains too, so bust it as well.
    invalidateInternalDomainsCache();
    invalidateStaffDefaultSuppressionCache();
    res.json(formatConfig(row!));
  }),
);

export default router;
