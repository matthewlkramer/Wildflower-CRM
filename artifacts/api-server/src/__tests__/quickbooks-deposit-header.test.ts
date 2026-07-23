import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveStagedPaymentStatus } from "../lib/derivedStatus";

// `buildSuperfluousHeaderDelete` imports `@workspace/db`, whose module init
// throws unless DATABASE_URL is set. We never open a connection here
// (`.toSQL()` only compiles the statement), so a dummy URL clears that guard.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const { pullIncomingPayments } = await import("../lib/quickbooksClient");
const { buildSuperfluousHeaderDelete, buildSuperfluousLineDelete } =
  await import("../lib/quickbooksSync");

/**
 * Whole-deposit `deposit_header` behavior:
 *
 *  1. EMISSION (quickbooksClient): a bank Deposit whose every line re-records
 *     an already-ingested Payment/SalesReceipt yields exactly ONE
 *     `deposit_header` row carrying the deposit's date / TOTAL / bank account
 *     (otherwise the deposit is invisible to settlement matching). Any direct
 *     line — including one linked to a non-ingested txn type like Transfer —
 *     means the line rows are the representation: NO header.
 *  2. STATUS: a header is never review work — it derives `excluded` by entity
 *     type alone; but confirmed settlement evidence naming it still wins
 *     (match_confirmed), exactly like a deposit-line lump.
 *  3. CLEANUP (quickbooksSync): when a later pull stages direct lines for a
 *     deposit, its now-superfluous header is deleted UNLESS review work
 *     references it (settlement link / source link / ledger row). The REVERSE
 *     transition is symmetric: when a pull emits a header, previously staged
 *     direct-line rows for that deposit are stale and deleted under the same
 *     reference guards PLUS a still-open (pending/excluded) status guard, so
 *     a human-resolved line row is never destroyed.
 *
 * SQL-CASE ↔ TS parity for the status arm is locked by
 * derived-status-builders.test.ts (rendering) and
 * derived-status-parity.integration.test.ts (execution).
 */

/** Minimal QB API fetch mock: empty QueryResponse for every entity except
 *  Deposit, which returns the supplied rows (single page). */
function mockQbFetch(deposits: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const query = decodeURIComponent(
        new URL(url).searchParams.get("query") ?? "",
      );
      const body: Record<string, unknown> = {};
      if (/FROM Deposit\b/i.test(query)) body["Deposit"] = deposits;
      return new Response(JSON.stringify({ QueryResponse: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  // Not strictly required (the mock never routes), but keeps URL parsing sane.
  process.env["QUICKBOOKS_API_BASE"] = "https://qb.test.invalid";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["QUICKBOOKS_API_BASE"];
});

const DEPOSIT_BASE = {
  Id: "D1",
  TotalAmt: 350,
  TxnDate: "2026-07-01",
  PrivateNote: "July batch",
  DepositToAccountRef: { value: "35", name: "Chase Checking" },
  MetaData: { LastUpdatedTime: "2026-07-02T00:00:00Z" },
};

const paymentLine = (id: string, amount: number, txnId: string) => ({
  Id: id,
  Amount: amount,
  LinkedTxn: [{ TxnType: "Payment", TxnId: txnId }],
});

describe("pullIncomingPayments — deposit_header emission", () => {
  it("all-linked deposit → exactly one whole-deposit header row", async () => {
    mockQbFetch([
      {
        ...DEPOSIT_BASE,
        Line: [paymentLine("1", 100, "P1"), paymentLine("2", 250, "P2")],
      },
    ]);
    const rows = await pullIncomingPayments("tok", "realm", null);

    // No deposit-line rows (each linked Payment is ingested as its own
    // entity — none appear here because the Payment query returned empty).
    expect(rows.filter((r) => r.qbEntityType === "deposit")).toEqual([]);

    const headers = rows.filter((r) => r.qbEntityType === "deposit_header");
    expect(headers).toHaveLength(1);
    const h = headers[0]!;
    // One idempotent unit per deposit, carrying the deposit's own facts.
    expect(h.qbEntityId).toBe("D1");
    expect(h.qbLineId).toBe("");
    expect(h.qbDepositId).toBe("D1");
    expect(h.amount).toBe("350.00");
    expect(h.dateReceived).toBe("2026-07-01");
    expect(h.qbDepositToAccountName).toBe("Chase Checking");
    // A header bundles MANY payers — it must never name one.
    expect(h.payerName).toBeNull();
    expect(h.qbPayerType).toBeNull();
    expect(h.qbPayerId).toBeNull();
    // Provenance: which Payments landed in this deposit.
    expect(h.qbLinkedTxn).toEqual([
      { txnType: "Payment", txnId: "P1" },
      { txnType: "Payment", txnId: "P2" },
    ]);
  });

  it("mixed deposit (any direct line) → line rows only, NO header", async () => {
    mockQbFetch([
      {
        ...DEPOSIT_BASE,
        Line: [
          paymentLine("1", 100, "P1"),
          {
            Id: "2",
            Amount: 250,
            Description: "Jane Donor check",
            DepositLineDetail: {
              AccountRef: { name: "Donations" },
            },
          },
        ],
      },
    ]);
    const rows = await pullIncomingPayments("tok", "realm", null);

    expect(rows.filter((r) => r.qbEntityType === "deposit_header")).toEqual(
      [],
    );
    const lines = rows.filter((r) => r.qbEntityType === "deposit");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.qbLineId).toBe("2");
    expect(lines[0]!.amount).toBe("250.00");
  });

  it("a line linked to a NON-ingested txn type (Transfer) is a direct line → NO header", async () => {
    mockQbFetch([
      {
        ...DEPOSIT_BASE,
        Line: [
          paymentLine("1", 100, "P1"),
          {
            Id: "2",
            Amount: 250,
            LinkedTxn: [{ TxnType: "Transfer", TxnId: "T9" }],
          },
        ],
      },
    ]);
    const rows = await pullIncomingPayments("tok", "realm", null);

    expect(rows.filter((r) => r.qbEntityType === "deposit_header")).toEqual(
      [],
    );
    expect(rows.filter((r) => r.qbEntityType === "deposit")).toHaveLength(1);
  });

  it("deposit with zero lines → nothing staged (no header either)", async () => {
    mockQbFetch([{ ...DEPOSIT_BASE, Line: [] }]);
    const rows = await pullIncomingPayments("tok", "realm", null);
    expect(rows).toEqual([]);
  });
});

describe("deriveStagedPaymentStatus — deposit_header arm", () => {
  const bare = {
    exclusionReason: null,
    autoApplied: false,
    matchConfirmedAt: null,
    hasCountedApplication: false,
  };

  it("a bare header derives excluded by entity type alone", () => {
    expect(
      deriveStagedPaymentStatus({ ...bare, qbEntityType: "deposit_header" }),
    ).toBe("excluded");
    // …while the same facts on a normal entity stay pending.
    expect(
      deriveStagedPaymentStatus({ ...bare, qbEntityType: "payment" }),
    ).toBe("pending");
    expect(deriveStagedPaymentStatus({ ...bare })).toBe("pending");
  });

  it("confirmed settlement evidence on a header still wins → match_confirmed", () => {
    expect(
      deriveStagedPaymentStatus({
        ...bare,
        qbEntityType: "deposit_header",
        hasConfirmedSettlementLink: true,
      }),
    ).toBe("match_confirmed");
  });

  it("a stored exclusion_reason still wins over the header arm", () => {
    expect(
      deriveStagedPaymentStatus({
        ...bare,
        exclusionReason: "other_revenue",
        qbEntityType: "deposit_header",
      }),
    ).toBe("excluded");
  });
});

describe("buildSuperfluousHeaderDelete — reference guards", () => {
  const compiled = buildSuperfluousHeaderDelete("realm-1", ["D1", "D2"]).toSQL()
    .sql;
  const lower = compiled.toLowerCase();

  it("targets ONLY deposit_header rows of the realm's listed deposits", () => {
    expect(lower).toContain('delete from "staged_payments"');
    expect(lower).toContain('"staged_payments"."realm_id" = ');
    expect(compiled).toContain(`"staged_payments"."qb_entity_type" = `);
    expect(lower).toContain('"staged_payments"."qb_entity_id" in (');
  });

  it("keeps any header that review work references (settled pairing / source link / ledger row)", () => {
    expect(lower).toContain('"settled_stripe_payout_id" is null');
    expect(lower).toContain('not exists (select 1 from "source_links"');
    expect(lower).toContain(
      'not exists (select 1 from "payment_applications"',
    );
  });
});

describe("buildSuperfluousLineDelete — reverse-transition guards", () => {
  const compiled = buildSuperfluousLineDelete("realm-1", ["D1", "D2"]).toSQL()
    .sql;
  const lower = compiled.toLowerCase();

  it("targets ONLY direct-line 'deposit' rows of the realm's listed deposits", () => {
    expect(lower).toContain('delete from "staged_payments"');
    expect(lower).toContain('"staged_payments"."realm_id" = ');
    expect(compiled).toContain(`"staged_payments"."qb_entity_type" = `);
    expect(lower).toContain('"staged_payments"."qb_entity_id" in (');
    // Must NOT be the header delete: the two builders are distinguished by the
    // entity-type parameter, so both types must appear as bind params overall —
    // asserted indirectly by the status guard below being line-only.
  });

  it("keeps any line that review work references (settled pairing / source link / ledger row)", () => {
    expect(lower).toContain('"settled_stripe_payout_id" is null');
    expect(lower).toContain('not exists (select 1 from "source_links"');
    expect(lower).toContain(
      'not exists (select 1 from "payment_applications"',
    );
  });

  it("additionally keeps human-resolved rows: a derived-status open guard is present (unlike the header delete, which needs none)", () => {
    // The status guard embeds the derived-status predicates; their presence is
    // what protects a manually confirmed/resolved line row from deletion.
    // Distinctive markers: the exclusion_reason branch and the confirmed
    // match/settlement evidence checks of the shared derived-status builder.
    expect(lower).toContain('"staged_payments"."exclusion_reason" is null');
    expect(lower).toContain('"staged_payments"."match_confirmed_at"');
    const header = buildSuperfluousHeaderDelete("realm-1", ["D1"])
      .toSQL()
      .sql.toLowerCase();
    expect(header).not.toContain("exclusion_reason");
    expect(header).not.toContain("match_confirmed_at");
  });
});
