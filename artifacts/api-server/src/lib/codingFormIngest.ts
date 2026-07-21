import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { codingFormRows } from "@workspace/db/schema";
import {
  parseCsv,
  parseFormSheet,
  type ParsedCodingFormRow,
} from "@workspace/coding-forms";
import { fetchSpreadsheetCsv } from "./googleSheetsCsv";
import { rematchPendingRows } from "./codingForms";
import { withSyncLock } from "./syncLock";
import { logger } from "./logger";

/**
 * Live ingest of the FY27 Donation Revenue Coding Form (a Google Sheet the
 * Google Form appends responses to) into the `coding_form_rows` staging table.
 *
 * Contract (same as the one-time CLI importer, ONE shared parser in
 * `@workspace/coding-forms`):
 *   - Deterministic ids `cfr_fy27_<index>` keyed to the sheet's data-row
 *     order, so re-ingesting is idempotent.
 *   - ON CONFLICT refreshes RAW/normalized captured values ONLY — never the
 *     proposed/confirmed match, reviewer `decisions`/`overrides`, `status`,
 *     applied-artifact ids, grant-letter import state, or AI-interpretation
 *     columns (compare-don't-clobber).
 *   - SHRINK GUARD: Google Form responses are append-only, so if the parsed
 *     row count is ever LOWER than what is already staged for fy27, a sheet
 *     row was deleted and every later index would shift onto the wrong
 *     staged row. We abort loudly instead of upserting.
 *   - After upserting, the existing rematch authority recomputes proposed
 *     matches for still-pending, never-confirmed rows (all sources — cheap at
 *     this scale and it is the ONE shared rematch path).
 */

export const FY27_SPREADSHEET_ID = "1YCzvChvlV1cFwD9M9HWvl7x-n45b9iG_U1o3k41mrnc";

/** Fixed lock subject — the ingest is system-wide, not per-user. */
const LOCK_SUBJECT = "coding-form-fy27";

export class Fy27ShrinkError extends Error {
  constructor(
    public readonly parsedCount: number,
    public readonly stagedCount: number,
  ) {
    super(
      `FY27 coding-form ingest aborted: parsed ${parsedCount} rows but ` +
        `${stagedCount} are already staged. Form responses are append-only — ` +
        "a sheet row was likely deleted, which would shift row identities. " +
        "Not upserting; investigate the sheet before re-running.",
    );
    this.name = "Fy27ShrinkError";
  }
}

export interface Fy27IngestSummary {
  ran: boolean;
  parsed: number;
  upserted: number;
  rematched: number;
}

async function upsertRow(row: ParsedCodingFormRow): Promise<void> {
  const id = `cfr_${row.source}_${row.sourceRowIndex}`;
  await db
    .insert(codingFormRows)
    .values({
      id,
      source: row.source,
      sourceRowIndex: row.sourceRowIndex,
      rawData: row.rawData,
      donorNameRaw: row.donorNameRaw,
      internalMemo: row.internalMemo,
      donorTypeRaw: row.donorTypeRaw,
      seriesTypeRaw: row.seriesTypeRaw,
      restrictionLanguage: row.restrictionLanguage,
      donorNameAddressRaw: row.donorNameAddressRaw,
      reportRequiredRaw: row.reportRequiredRaw,
      driveLink: row.driveLink,
      circleRaw: row.circleRaw,
      additionalNotes: row.additionalNotes,
      paymentMethodRaw: row.paymentMethodRaw,
      stripeFeesRaw: row.stripeFeesRaw,
      classRaw: row.classRaw,
      submitterEmail: row.submitterEmail,
      wildflowerPartner: row.wildflowerPartner,
      amount: row.amount,
      donationDate: row.donationDate,
      depositDate: row.depositDate,
      addrStreet: row.addrStreet,
      addrCity: row.addrCity,
      addrState: row.addrState,
      addrPostal: row.addrPostal,
      addrCountry: row.addrCountry,
      reportRequired: row.reportRequired,
      reportDueDate: row.reportDueDate,
      intendedUsageSuggested: row.intendedUsageSuggested,
    })
    .onConflictDoUpdate({
      target: codingFormRows.id,
      // Raw/normalized captured values ONLY — never match / decisions /
      // status / applied / grant-letter / AI columns.
      set: {
        rawData: row.rawData,
        donorNameRaw: row.donorNameRaw,
        internalMemo: row.internalMemo,
        donorTypeRaw: row.donorTypeRaw,
        seriesTypeRaw: row.seriesTypeRaw,
        restrictionLanguage: row.restrictionLanguage,
        donorNameAddressRaw: row.donorNameAddressRaw,
        reportRequiredRaw: row.reportRequiredRaw,
        driveLink: row.driveLink,
        circleRaw: row.circleRaw,
        additionalNotes: row.additionalNotes,
        paymentMethodRaw: row.paymentMethodRaw,
        stripeFeesRaw: row.stripeFeesRaw,
        classRaw: row.classRaw,
        submitterEmail: row.submitterEmail,
        wildflowerPartner: row.wildflowerPartner,
        amount: row.amount,
        donationDate: row.donationDate,
        depositDate: row.depositDate,
        addrStreet: row.addrStreet,
        addrCity: row.addrCity,
        addrState: row.addrState,
        addrPostal: row.addrPostal,
        addrCountry: row.addrCountry,
        reportRequired: row.reportRequired,
        reportDueDate: row.reportDueDate,
        intendedUsageSuggested: row.intendedUsageSuggested,
        updatedAt: new Date(),
      },
    });
}

/**
 * Upsert already-parsed FY27 rows (shrink guard + compare-don't-clobber), then
 * recompute proposed matches for unconfirmed pending rows. Split out from the
 * fetch so tests can drive it with in-memory rows.
 */
export async function ingestFy27Rows(
  rows: ParsedCodingFormRow[],
): Promise<Omit<Fy27IngestSummary, "ran">> {
  for (const r of rows) {
    if (r.source !== "fy27") {
      throw new Error(
        `ingestFy27Rows received a non-fy27 row (source=${r.source})`,
      );
    }
  }

  const [{ staged } = { staged: 0 }] = await db
    .select({ staged: sql<number>`count(*)::int` })
    .from(codingFormRows)
    .where(sql`${codingFormRows.source} = 'fy27'`);
  if (rows.length < Number(staged)) {
    throw new Fy27ShrinkError(rows.length, Number(staged));
  }

  for (const row of rows) {
    await upsertRow(row);
  }

  const rematch = await rematchPendingRows();
  return { parsed: rows.length, upserted: rows.length, rematched: rematch.updated };
}

/**
 * Fetch the live FY27 sheet as CSV, parse it with the shared parser, and
 * ingest. Serialized behind the shared sync-lock convention so overlapping
 * ticks / manual runs can't collide. Throws on any fetch/parse/guard failure —
 * callers (the scheduler) log; failures never mutate staged rows.
 */
export async function syncFy27CodingForm(): Promise<Fy27IngestSummary> {
  const outcome = await withSyncLock(LOCK_SUBJECT, "coding_forms", async () => {
    const csv = await fetchSpreadsheetCsv(FY27_SPREADSHEET_ID);
    const cells = parseCsv(csv);
    if (cells.length === 0) {
      // A readable-but-empty export is indistinguishable from a format
      // change; the shrink guard below would also catch it once rows exist,
      // but fail loudly on the degenerate case too.
      throw new Error("FY27 sheet export returned no rows (empty CSV)");
    }
    const rows = parseFormSheet("fy27", cells);
    const summary = await ingestFy27Rows(rows);
    logger.info({ ...summary }, "FY27 coding-form ingest complete");
    return summary;
  });
  if (!outcome.ran || !outcome.result) {
    return { ran: false, parsed: 0, upserted: 0, rematched: 0 };
  }
  return { ran: true, ...outcome.result };
}
