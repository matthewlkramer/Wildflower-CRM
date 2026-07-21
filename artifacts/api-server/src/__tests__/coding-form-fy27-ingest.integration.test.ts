import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ParsedCodingFormRow } from "@workspace/coding-forms";

/**
 * FY27 daily ingest contract (DB-backed):
 *
 *   1. Idempotency — a second run with identical parsed rows changes nothing
 *      (raw values equal, no status/match churn).
 *   2. Compare-don't-clobber — edited RAW values refresh on re-run, but a
 *      confirmed match, reviewer decisions, and status are never touched.
 *   3. Shrink guard — Google Form responses are append-only, so a parsed row
 *      count LOWER than what is already staged aborts with Fy27ShrinkError
 *      and upserts nothing.
 *
 * Uses ingestFy27Rows (the upsert+guard core) directly with in-memory parsed
 * rows — the sheet fetch itself is a thin connector call exercised in dev.
 * Skips when no real DATABASE_URL.
 */

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

type Db = typeof import("@workspace/db");
let db: Db["db"];
let codingFormRows: Db["codingFormRows"];
let eqFn: (typeof import("drizzle-orm"))["eq"];
let ingestFy27Rows: (typeof import("../lib/codingFormIngest"))["ingestFy27Rows"];
let Fy27ShrinkError: (typeof import("../lib/codingFormIngest"))["Fy27ShrinkError"];

function parsedRow(
  index: number,
  overrides: Partial<ParsedCodingFormRow> = {},
): ParsedCodingFormRow {
  return {
    source: "fy27",
    sourceRowIndex: index,
    rawData: { donorName: `FY27 Test Donor ${index}` },
    donorNameRaw: `FY27 Test Donor ${index}`,
    internalMemo: null,
    donorTypeRaw: null,
    seriesTypeRaw: null,
    restrictionLanguage: null,
    donorNameAddressRaw: null,
    reportRequiredRaw: null,
    driveLink: null,
    circleRaw: null,
    additionalNotes: null,
    paymentMethodRaw: null,
    stripeFeesRaw: null,
    classRaw: null,
    submitterEmail: null,
    wildflowerPartner: null,
    amount: "123.45",
    donationDate: "2099-07-01",
    depositDate: null,
    addrStreet: null,
    addrCity: null,
    addrState: null,
    addrPostal: null,
    addrCountry: null,
    reportRequired: false,
    reportDueDate: null,
    intendedUsageSuggested: null,
    ...overrides,
  };
}

async function loadFy27() {
  return db
    .select()
    .from(codingFormRows)
    .where(eqFn(codingFormRows.source, "fy27"))
    .orderBy(codingFormRows.sourceRowIndex);
}

describe.skipIf(!HAS_DB)("FY27 coding-form ingest", () => {
  beforeAll(async () => {
    const dbMod = await import("@workspace/db");
    db = dbMod.db;
    const schema = await import("@workspace/db/schema");
    codingFormRows = schema.codingFormRows;
    ({ eq: eqFn } = await import("drizzle-orm"));
    ({ ingestFy27Rows, Fy27ShrinkError } = await import(
      "../lib/codingFormIngest"
    ));
    await db
      .delete(codingFormRows)
      .where(eqFn(codingFormRows.source, "fy27"));
  }, 60_000);

  afterAll(async () => {
    await db
      .delete(codingFormRows)
      .where(eqFn(codingFormRows.source, "fy27"));
  }, 30_000);

  it(
    "ingests, is idempotent, refreshes raw values without clobbering review state, and aborts on shrink",
    async () => {
      // ── First ingest ────────────────────────────────────────────────────
      const first = await ingestFy27Rows([parsedRow(0), parsedRow(1)]);
      expect(first.upserted).toBe(2);
      let rows = await loadFy27();
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe("cfr_fy27_0");
      expect(rows[1].id).toBe("cfr_fy27_1");
      const firstUpdatedAt = rows[0].updatedAt;

      // ── Simulate human review on row 0 ──────────────────────────────────
      const confirmedAt = new Date("2099-01-02T03:04:05Z");
      await db
        .update(codingFormRows)
        .set({
          organizationId: "org_test_fy27",
          matchedGiftId: "gift_test_fy27",
          matchMethod: "manual",
          matchTier: "high",
          matchConfirmedAt: confirmedAt,
          decisions: { address: "apply" },
          status: "applied",
          aiInterpretation: { note: "keep me" },
        })
        .where(eqFn(codingFormRows.id, "cfr_fy27_0"));

      // ── Second run: identical row 1, edited raw value on row 0 ──────────
      const second = await ingestFy27Rows([
        parsedRow(0, { internalMemo: "edited memo", amount: "150.00" }),
        parsedRow(1),
      ]);
      expect(second.upserted).toBe(2);
      rows = await loadFy27();

      // Raw/normalized values refreshed…
      expect(rows[0].internalMemo).toBe("edited memo");
      expect(String(rows[0].amount)).toBe("150.00");
      // …review state untouched (compare-don't-clobber).
      expect(rows[0].organizationId).toBe("org_test_fy27");
      expect(rows[0].matchedGiftId).toBe("gift_test_fy27");
      expect(rows[0].matchConfirmedAt?.getTime()).toBe(confirmedAt.getTime());
      expect(rows[0].decisions).toEqual({ address: "apply" });
      expect(rows[0].status).toBe("applied");
      expect(rows[0].aiInterpretation).toEqual({ note: "keep me" });
      // Untouched identical row 1 keeps its values.
      expect(rows[1].donorNameRaw).toBe("FY27 Test Donor 1");
      expect(firstUpdatedAt).toBeTruthy();

      // ── Shrink guard: fewer parsed rows than staged aborts ──────────────
      await expect(ingestFy27Rows([parsedRow(0)])).rejects.toBeInstanceOf(
        Fy27ShrinkError,
      );
      // Nothing was deleted or modified by the aborted run.
      rows = await loadFy27();
      expect(rows).toHaveLength(2);
      expect(rows[0].internalMemo).toBe("edited memo");

      // Non-fy27 rows are rejected outright.
      await expect(
        ingestFy27Rows([parsedRow(0, { source: "fy26" })]),
      ).rejects.toThrow(/non-fy27/);
    },
    120_000,
  );
});

describe("coding-form sync scheduler wiring", () => {
  it("start/stop are safe under NODE_ENV=test (no timer scheduled)", async () => {
    const mod = await import("../lib/codingFormSyncScheduler");
    // NODE_ENV=test → start returns without scheduling; both are no-throw.
    mod.startCodingFormSyncScheduler();
    mod.stopCodingFormSyncScheduler();
  });
});
