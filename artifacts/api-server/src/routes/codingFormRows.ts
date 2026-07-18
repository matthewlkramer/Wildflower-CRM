import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  codingFormRows,
  giftsAndPayments,
  opportunitiesAndPledges,
} from "@workspace/db/schema";
import { and, count, eq, sql, type SQL } from "drizzle-orm";
import {
  ListCodingFormRowsQueryParams,
  SetCodingFormMatchBody,
  ApplyCodingFormRowBody,
  PullGrantAgreementBody,
} from "@workspace/api-zod";
import {
  deriveGrantAgreement,
  loadTargetGrantLetter,
  pullGrantAgreement,
  resolveGrantLetterTarget,
} from "../lib/grantAgreements";
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
  rematchPendingRows,
  confirmMatchedRows,
  applyDecidedRows,
  applyRow,
  NEEDS_DECISION_FIELDS_META,
} from "../lib/codingForms";
import { reinterpretRow, reinterpretRows } from "../lib/codingFormAi";
import { z } from "zod";

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

/**
 * Donor FKs of a matched record for inheritance (gift preferred over
 * opportunity — the gift IS the money being coded). Returns null when neither
 * id resolves, so the caller leaves the donor cleared rather than guessing.
 */
async function inheritDonorFromRecord(
  giftId: string | null,
  opportunityId: string | null,
): Promise<{
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
} | null> {
  if (giftId) {
    const [g] = await db
      .select({
        organizationId: giftsAndPayments.organizationId,
        individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
        householdId: giftsAndPayments.householdId,
      })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.id, giftId));
    if (g) return g;
  }
  if (opportunityId) {
    const [o] = await db
      .select({
        organizationId: opportunitiesAndPledges.organizationId,
        individualGiverPersonId: opportunitiesAndPledges.individualGiverPersonId,
        householdId: opportunitiesAndPledges.householdId,
      })
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, opportunityId));
    if (o) return o;
  }
  return null;
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
    if (q.hasDriveLink === true)
      filters.push(sql`NULLIF(TRIM(${codingFormRows.driveLink}), '') IS NOT NULL`);
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
// human-confirmed match. When the reviewer picks a gift/opportunity WITHOUT
// naming a donor, the donor is INHERITED from the picked record (gift wins) —
// record-first semantics; the record's Donor XOR guarantees exactly one FK.
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

    // Inherit the donor from the matched record when none was provided.
    let donor = {
      organizationId: body.organizationId ?? null,
      individualGiverPersonId: body.individualGiverPersonId ?? null,
      householdId: body.householdId ?? null,
    };
    if (donorCount === 0 && (body.matchedGiftId || body.matchedOpportunityId)) {
      const inherited = await inheritDonorFromRecord(
        body.matchedGiftId ?? null,
        body.matchedOpportunityId ?? null,
      );
      if (inherited) donor = inherited;
    }

    const user = await getAppUser(req);
    const [updated] = await db
      .update(codingFormRows)
      .set({
        organizationId: donor.organizationId,
        individualGiverPersonId: donor.individualGiverPersonId,
        householdId: donor.householdId,
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

// Bulk re-run the matcher over every row that is still pending AND has never
// been human-confirmed. rematchRow clears confirmations and rewrites donor FKs,
// so confirmed / applied / skipped rows are excluded by the query itself
// (see rematchPendingRows) — this endpoint can never clobber a human decision.
router.post(
  "/coding-form-rows/rematch-pending",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(await rematchPendingRows());
  }),
);

// Approve the row's CURRENT proposed link as-is: stamps matchConfirmedAt + the
// confirming user WITHOUT rewriting the proposal (unlike PATCH /match, which
// overwrites all five link fields and re-stamps provenance as manual). A
// confirmed row is excluded from every bulk rematch pass.
router.post(
  "/coding-form-rows/:id/confirm-match",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");

    const hasDonor =
      row.organizationId != null ||
      row.individualGiverPersonId != null ||
      row.householdId != null;
    if (!hasDonor) {
      res.status(409).json({
        error:
          "Nothing to confirm — this row has no matched donor. Set a donor first, or use Re-match.",
      });
      return;
    }

    const user = await getAppUser(req);
    const [updated] = await db
      .update(codingFormRows)
      .set({
        matchConfirmedAt: new Date(),
        matchConfirmedByUserId: user?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(codingFormRows.id, id))
      .returning();
    res.json(await serializeRow(updated));
  }),
);

// Bulk-approve the auto-matcher's proposals: every still-pending,
// never-confirmed row with BOTH a donor AND a matched gift gets its
// confirmation stamped. Never touches human-confirmed / applied / skipped rows
// and never rewrites the proposal itself.
router.post(
  "/coding-form-rows/confirm-matched",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const user = await getAppUser(req);
    res.json(await confirmMatchedRows(user?.id ?? null));
  }),
);

// Bulk apply: every pending + match-confirmed row with stored decisions goes
// through the same applyRow path as the per-row Apply. Per-row failures are
// summarized, never thrown.
router.post(
  "/coding-form-rows/apply-decided",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const user = await getAppUser(req);
    res.json(await applyDecidedRows(user?.id ?? null));
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

// Grant-agreement backfill (Task #485) — pull the row's Drive file and attach it
// to the matched OPPORTUNITY/PLEDGE via the normal grant-letter flow. Idempotent
// (already-imported → 200 noop); never silently overwrites an existing letter
// (conflict → 409 unless `replace: true`); a Drive fetch failure is recorded on
// the row and returned as a `failed` outcome (200) so the reviewer sees it.
router.post(
  "/coding-form-rows/:id/pull-grant-agreement",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const body = parseOrBadRequest(PullGrantAgreementBody, req.body, res);
    if (!body) return;
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");

    const user = await getAppUser(req);
    const result = await pullGrantAgreement(row, {
      replace: body.replace === true,
      userId: user?.id ?? null,
    });

    if (result.kind === "no_link") {
      res
        .status(409)
        .json({ error: "This row has no grant-agreement Drive link." });
      return;
    }
    if (result.kind === "no_match") {
      res.status(409).json({
        error:
          "This row has no matched opportunity or gift to attach the grant agreement to.",
      });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({
        error:
          "The matched record already has a grant letter. Re-send with replace=true to overwrite it.",
        code: "grant_letter_conflict",
      });
      return;
    }

    const updated = await loadRow(id);
    res.json({
      row: await serializeRow(updated!),
      outcome: result.kind,
      replaced: result.kind === "imported" ? result.replaced : false,
      error: result.kind === "failed" ? result.error : null,
    });
  }),
);

// Bulk grant-agreement pull — attaches every actionable row's Drive file to its
// matched opportunity-else-gift. Conservative by design: bulk NEVER replaces an
// existing letter (conflicts are left for per-row review with replace=true);
// per-row Drive failures are recorded on the row and reported, not thrown.
// Sequential on purpose (Drive + object-storage friendliness at ~300-row scale).
router.post(
  "/coding-form-rows/pull-grant-agreements",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const user = await getAppUser(req);

    const rows = await db
      .select()
      .from(codingFormRows)
      .where(sql`NULLIF(TRIM(${codingFormRows.driveLink}), '') IS NOT NULL`)
      .orderBy(codingFormRows.sourceRowIndex);

    const counts = {
      attempted: 0,
      imported: 0,
      alreadyImported: 0,
      conflict: 0,
      noMatch: 0,
      failed: 0,
    };
    const failures: Array<{ rowId: string; error: string }> = [];
    for (const row of rows) {
      const status = deriveGrantAgreement(
        row,
        await loadTargetGrantLetter(resolveGrantLetterTarget(row)),
      ).status;
      if (status === "na") continue;
      if (status === "imported") {
        counts.alreadyImported++;
        continue;
      }
      if (status === "conflict") {
        counts.conflict++;
        continue;
      }
      if (status === "no_match") {
        counts.noMatch++;
        continue;
      }
      // ready OR failed (a bulk re-run retries recorded transient failures)
      counts.attempted++;
      const result = await pullGrantAgreement(row, {
        replace: false,
        userId: user?.id ?? null,
      });
      if (result.kind === "imported") counts.imported++;
      else if (result.kind === "already_imported") counts.alreadyImported++;
      else if (result.kind === "conflict") counts.conflict++;
      else if (result.kind === "no_match") counts.noMatch++;
      else if (result.kind === "failed") {
        counts.failed++;
        failures.push({ rowId: row.id, error: result.error });
      }
    }

    res.json({ totalWithLink: rows.length, ...counts, failures });
  }),
);

// AI reinterpretation — one row. Always (re-)runs the model for the row, even
// when a payload already exists (the reviewer explicitly asked). A failure is
// recorded on the row (`aiError`) and reported in the response, never thrown.
router.post(
  "/coding-form-rows/:id/reinterpret",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const row = await loadRow(id);
    if (!row) return notFound(res, "coding form row");

    const outcome = await reinterpretRow(row);
    const updated = await loadRow(id);
    res.json({
      row: await serializeRow(updated!),
      ok: outcome.ok,
      error: outcome.ok ? null : outcome.error,
    });
  }),
);

// AI reinterpretation — bulk over PENDING rows (applied/skipped rows are
// settled; their payload only changes via the per-row endpoint). Default skips
// rows that already have a payload so a re-run only fills gaps + retries
// failures; `force: true` reinterprets every pending row. Runs through the
// rate-limit-aware batch runner (concurrency 2); per-row failures are recorded
// on the rows and summarized, never thrown.
//
// `limit` caps one pass so the client can chunk (a full ~284-row pass would
// outlive the HTTP request). Never-failed rows sort FIRST so chunked re-calls
// always make progress; once only persistently-failing rows remain, a chunk
// comes back with succeeded=0 and the client stops.
const ReinterpretAllBody = z
  .object({
    force: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .nullish();
router.post(
  "/coding-form-rows/reinterpret",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = ReinterpretAllBody.safeParse(req.body);
    const force = body.success ? (body.data?.force ?? false) : false;
    const limit = body.success ? (body.data?.limit ?? null) : null;

    const baseQuery = db
      .select()
      .from(codingFormRows)
      .where(
        force
          ? eq(codingFormRows.status, "pending")
          : and(
              eq(codingFormRows.status, "pending"),
              sql`${codingFormRows.aiInterpretation} IS NULL`,
            ),
      )
      .orderBy(
        sql`(${codingFormRows.aiError} IS NOT NULL)`,
        codingFormRows.sourceRowIndex,
      );
    const rows = limit ? await baseQuery.limit(limit) : await baseQuery;

    const outcomes = await reinterpretRows(rows);
    const failures = outcomes.flatMap((o) =>
      o.ok ? [] : [{ rowId: o.rowId, error: o.error }],
    );
    res.json({
      total: rows.length,
      succeeded: outcomes.length - failures.length,
      failed: failures.length,
      failures,
    });
  }),
);

// Grant-agreement backfill progress — counts by derived grant-agreement status
// across the rows that carry a Drive link (the before/after the reviewer sees).
router.get(
  "/coding-form-grant-agreements-summary",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const rows = await db
      .select()
      .from(codingFormRows)
      .where(sql`NULLIF(TRIM(${codingFormRows.driveLink}), '') IS NOT NULL`);

    const counts: Record<string, number> = {
      na: 0,
      no_match: 0,
      ready: 0,
      imported: 0,
      conflict: 0,
      failed: 0,
    };
    for (const row of rows) {
      const letter = await loadTargetGrantLetter(resolveGrantLetterTarget(row));
      const { status } = deriveGrantAgreement(row, letter);
      counts[status] = (counts[status] ?? 0) + 1;
    }

    res.json({
      totalWithLink: rows.length,
      byStatus: Object.entries(counts)
        .filter(([, count]) => count > 0)
        .map(([key, count]) => ({ key, count })),
    });
  }),
);

export default router;
