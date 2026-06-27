import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { codingFormRows } from "@workspace/db/schema";
import { and, count, eq, sql, type SQL } from "drizzle-orm";
import {
  ListCodingFormRowsQueryParams,
  SetCodingFormMatchBody,
  ApplyCodingFormRowBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import {
  serializeRow,
  rematchRow,
  applyRow,
  NEEDS_DECISION_FIELDS_META,
} from "../lib/codingForms";

// One-time Donation Coding Form import + reconciliation (Task #484). Admin-gated:
// this is a finance back-office migration tool, not a day-to-day CRM surface.
//
// The staging table `coding_form_rows` holds the parsed spreadsheet rows. The
// cross-check (sheet vs CRM, per attribute: new/same/conflict/na) is computed
// LIVE on read in `serializeRow` so it can never go stale; only the reviewer's
// per-attribute decision and the apply artifacts are persisted. Compare-don't-
// clobber: apply only fills genuinely-missing values + reviewer-approved
// conflicts, and is idempotent on re-run.

const router: IRouter = Router();
router.use(requireAuth);

async function loadRow(id: string) {
  return db
    .select()
    .from(codingFormRows)
    .where(eq(codingFormRows.id, id))
    .then((r) => r[0] ?? null);
}

// List — filter by source / status, paginated. Auto-match any never-matched row
// (matchMethod IS NULL) on first read so the queue is useful immediately.
router.get(
  "/coding-form-rows",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = parseOrBadRequest(ListCodingFormRowsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    const filters: SQL[] = [];
    if (q.source) filters.push(eq(codingFormRows.source, q.source));
    if (q.status) filters.push(eq(codingFormRows.status, q.status));
    if (q.matchTier) filters.push(eq(codingFormRows.matchTier, q.matchTier));
    const where = filters.length ? and(...filters) : undefined;

    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(codingFormRows)
        .where(where)
        .orderBy(codingFormRows.source, codingFormRows.sourceRowIndex)
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(codingFormRows).where(where),
    ]);

    // Auto-propose a match for rows that have never been matched.
    const serialized = await Promise.all(
      rows.map(async (row) => {
        const r = row.matchMethod == null ? await rematchRow(row) : row;
        return serializeRow(r);
      }),
    );

    res.json({
      data: serialized,
      pagination: { page, limit, total: Number(total) },
    });
  }),
);

// Summary — counts by status + source + needs-decision attribute coverage.
router.get(
  "/coding-form-rows-summary",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const [[{ value: total } = { value: 0 }], byStatus, bySource] =
      await Promise.all([
        db.select({ value: count() }).from(codingFormRows),
        db
          .select({ key: codingFormRows.status, count: count() })
          .from(codingFormRows)
          .groupBy(codingFormRows.status),
        db
          .select({ key: codingFormRows.source, count: count() })
          .from(codingFormRows)
          .groupBy(codingFormRows.source),
      ]);

    // Needs-decision: rows carrying a value for each no-schema-home attribute.
    const needsDecision = await Promise.all(
      NEEDS_DECISION_FIELDS_META.map(async (f) => {
        const [{ value } = { value: 0 }] = await db
          .select({ value: count() })
          .from(codingFormRows)
          .where(f.nonEmpty);
        return { key: f.attribute, count: Number(value) };
      }),
    );

    res.json({
      total: Number(total),
      byStatus: byStatus.map((r) => ({ key: r.key, count: Number(r.count) })),
      bySource: bySource.map((r) => ({ key: r.key, count: Number(r.count) })),
      needsDecision: needsDecision.filter((r) => r.count > 0),
    });
  }),
);

// Get one row (with live cross-check).
router.get(
  "/coding-form-rows/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    let row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");
    if (row.matchMethod == null) row = await rematchRow(row);
    res.json(await serializeRow(row));
  }),
);

// Set the donor + opportunity/gift match by hand (donor XOR), and stamp it as a
// human-confirmed match.
router.patch(
  "/coding-form-rows/:id/match",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const body = parseOrBadRequest(SetCodingFormMatchBody, req.body, res);
    if (!body) return;
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");

    // Donor XOR: at most one donor FK may be set.
    const donorCount = [
      body.organizationId,
      body.individualGiverPersonId,
      body.householdId,
    ].filter((x) => x != null && x !== "").length;
    if (donorCount > 1) {
      res.status(400).json({
        error:
          "A coding form row can have at most one donor (organization, individual, or household).",
      });
      return;
    }

    const user = await getAppUser(req);
    const [updated] = await db
      .update(codingFormRows)
      .set({
        organizationId: body.organizationId ?? null,
        individualGiverPersonId: body.individualGiverPersonId ?? null,
        householdId: body.householdId ?? null,
        matchedOpportunityId: body.matchedOpportunityId ?? null,
        matchedGiftId: body.matchedGiftId ?? null,
        matchMethod: "manual",
        matchTier: "high",
        matchConfirmedAt: new Date(),
        matchConfirmedByUserId: user?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(codingFormRows.id, id))
      .returning();

    res.json(await serializeRow(updated));
  }),
);

// Re-run the auto matcher, discarding any prior (unconfirmed) proposal.
router.post(
  "/coding-form-rows/:id/rematch",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");
    const updated = await rematchRow(row);
    res.json(await serializeRow(updated));
  }),
);

// Apply the reviewer-approved attributes (idempotent).
router.post(
  "/coding-form-rows/:id/apply",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const body = parseOrBadRequest(ApplyCodingFormRowBody, req.body, res);
    if (!body) return;
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");

    const user = await getAppUser(req);
    const outcome = await applyRow(row, body.decisions, user?.id ?? null);

    // Apply integrity: never silently mark a row "applied" with nothing written.
    // Nothing actionable + not already applied → 409 so the reviewer knows their
    // approvals had no effect (e.g. all `same`, or blocked by an unresolved match).
    if (outcome.kind === "nothing_to_apply") {
      res.status(409).json({
        error:
          "No approved attributes are actionable — every approved attribute is already up to date, not applicable, or blocked by an unresolved donor/opportunity match.",
      });
      return;
    }

    const updated = await loadRow(id);
    res.json({
      row: await serializeRow(updated!),
      applied: outcome.kind === "applied" ? outcome.applied : [],
      skipped: outcome.kind === "applied" ? outcome.skipped : [],
    });
  }),
);

// Skip a row (mark resolved without applying anything).
router.post(
  "/coding-form-rows/:id/skip",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");
    const [updated] = await db
      .update(codingFormRows)
      .set({ status: "skipped", updatedAt: new Date() })
      .where(eq(codingFormRows.id, id))
      .returning();
    res.json(await serializeRow(updated));
  }),
);

export default router;
