import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  DERIVED_STATUSES,
  quotedSqlAlias,
  qbCountedExistsText,
  qbSettledExistsText,
  qbChargeTieBookedExistsText,
  qbChargeTieLinkExistsText,
  qbProposedText,
  qbConfirmedEvidenceText,
  qbSettlementClaimedText,
  qbHasSplitChildrenText,
  qbResolvedElsewhereText,
  qbIsDepositHeaderText,
  qbStatusCaseText,
  qbOpenText,
  chargeCountedExistsText,
  chargeProposedText,
  chargeStatusCaseText,
  chargeOpenText,
  chargeConfirmedText,
  stagedStatusSql,
  stagedStatusWhere,
  stagedCountedApplicationExists,
  stagedConfirmedSettlementLinkExists,
  stagedChargeTieExists,
  stagedChargeTieLinkExists,
  stagedHasSplitChildren,
  chargeStatusSql,
  chargeStatusWhere,
  chargeCountedApplicationExists,
} from "../lib/derivedStatus";

/**
 * SQL-RENDERING parity for the centralized derived-status builders:
 *
 *   1. `quotedSqlAlias` is the only path caller text takes into the raw SQL —
 *      it must reject anything that is not a plain lowercase identifier
 *      (injection defense) and the builders' reserved internal aliases.
 *   2. Every identifier the builders emit is double-quoted, exactly as
 *      drizzle renders identifiers.
 *   3. The base-table drizzle fragments are the SAME text the builders emit
 *      for the base-table alias — one derivation, two entry points.
 *   4. Tie roles: the QB status CASE consults the BOOKED tie predicate for
 *      match_confirmed, and the raw tie-linkage predicate ONLY inside the
 *      settlement-claim arm (a confirmed tie settles the row out of the
 *      donation queue → derives `excluded`). Charge derivations never
 *      consult the tie at all.
 *
 * Execution parity against live PostgreSQL lives in
 * derived-status-parity.integration.test.ts.
 */

const dialect = new PgDialect();
const render = (fragment: SQL<unknown>): string =>
  dialect.sqlToQuery(fragment).sql;

const QB = "staged_payments";
const CH = "stripe_staged_charges";

describe("quotedSqlAlias", () => {
  it("quotes plain lowercase identifiers", () => {
    expect(quotedSqlAlias("s")).toBe('"s"');
    expect(quotedSqlAlias("active_deposit")).toBe('"active_deposit"');
    expect(quotedSqlAlias("_x1")).toBe('"_x1"');
    expect(quotedSqlAlias("staged_payments")).toBe('"staged_payments"');
  });

  it("rejects anything that is not a plain lowercase identifier", () => {
    for (const bad of [
      "",
      "1a",
      "S",
      "Foo",
      "a b",
      "a.b",
      "a-b",
      'a"b',
      "a;DROP TABLE gifts_and_payments;--",
      "a')) OR 1=1 --",
      "café",
    ]) {
      expect(() => quotedSqlAlias(bad), bad).toThrow(
        /plain lowercase SQL identifier/,
      );
    }
  });

  it("rejects the builders' reserved internal subquery aliases", () => {
    for (const reserved of ["pa_ds", "sl_ds", "cc_ds", "pa_ct_ds"]) {
      expect(() => quotedSqlAlias(reserved), reserved).toThrow(/reserved/);
    }
  });

  it("every builder validates its alias (no unvalidated entry point)", () => {
    const builders: Array<(a: string) => string> = [
      qbCountedExistsText,
      qbSettledExistsText,
      qbChargeTieBookedExistsText,
      qbChargeTieLinkExistsText,
      qbProposedText,
      qbConfirmedEvidenceText,
      qbIsDepositHeaderText,
      qbStatusCaseText,
      qbOpenText,
      chargeCountedExistsText,
      chargeProposedText,
      chargeStatusCaseText,
      chargeOpenText,
      chargeConfirmedText,
    ];
    for (const b of builders) {
      expect(() => b('x";DROP TABLE users;--')).toThrow();
      expect(() => b("pa_ds")).toThrow();
    }
  });
});

describe("builders emit consistently quoted identifiers", () => {
  it("qualifies every alias column reference with the quoted alias", () => {
    const qb = qbStatusCaseText("s") + qbOpenText("s");
    expect(qb).toContain('"s"."exclusion_reason"');
    expect(qb).toContain('"s"."auto_applied"');
    expect(qb).toContain('"s"."match_confirmed_at"');
    expect(qb).toContain('"s"."id"');
    // No unquoted alias usage anywhere (an unquoted `s.` would appear as a
    // word boundary + s + dot NOT preceded by a double quote).
    expect(qb).not.toMatch(/(?<!")\bs\./);

    const ch = chargeStatusCaseText("cc") + chargeOpenText("cc") + chargeConfirmedText("cc");
    expect(ch).toContain('"cc"."exclusion_reason"');
    expect(ch).toContain('"cc"."id"');
    expect(ch).not.toMatch(/(?<!")\bcc\./);
  });

  it("quotes the internal subquery tables and aliases", () => {
    expect(qbCountedExistsText("s")).toContain(
      'FROM "payment_applications" "pa_ds"',
    );
    expect(qbSettledExistsText("s")).toContain(
      '"s"."settled_stripe_payout_id"',
    );
    expect(qbChargeTieBookedExistsText("s")).toContain(
      'FROM "source_links" "srcl_ds"',
    );
  });
});

describe("status CASE shape", () => {
  it("enumerates every derived status (QB: excluded three times — exclusion_reason + settlement claim + deposit header)", () => {
    for (const status of DERIVED_STATUSES) {
      // QB CASE: `excluded` appears three times by design — the stored
      // exclusion_reason arm, the settlement-claim arm, AND the
      // deposit_header entity-type arm (a whole-deposit header is never
      // donation-review work; its money lives on the underlying Payments).
      expect(
        qbStatusCaseText("s").split(`'${status}'`).length - 1,
        `qb ${status}`,
      ).toBe(status === "excluded" ? 3 : 1);
      expect(
        chargeStatusCaseText("s").split(`'${status}'`).length - 1,
        `charge ${status}`,
      ).toBe(1);
    }
  });
});

describe("base-table drizzle fragments render the builders' text (one source)", () => {
  it("staged_payments fragments", () => {
    expect(render(stagedStatusSql)).toBe(qbStatusCaseText(QB));
    expect(render(stagedCountedApplicationExists)).toBe(qbCountedExistsText(QB));
    expect(render(stagedConfirmedSettlementLinkExists)).toBe(
      qbSettledExistsText(QB),
    );
    expect(render(stagedChargeTieExists)).toBe(qbChargeTieBookedExistsText(QB));
    expect(render(stagedChargeTieLinkExists)).toBe(qbChargeTieLinkExistsText(QB));
    expect(render(stagedHasSplitChildren)).toBe(qbHasSplitChildrenText(QB));

    expect(render(stagedStatusWhere.excluded)).toBe(
      `("${QB}"."exclusion_reason" IS NOT NULL OR (NOT ${qbProposedText(QB)} AND NOT ${qbConfirmedEvidenceText(QB)} AND (${qbResolvedElsewhereText(QB)} OR ${qbIsDepositHeaderText(QB)})))`,
    );
    expect(render(stagedStatusWhere.match_proposed)).toBe(
      `("${QB}"."exclusion_reason" IS NULL AND ${qbProposedText(QB)})`,
    );
    expect(render(stagedStatusWhere.match_confirmed)).toBe(
      `("${QB}"."exclusion_reason" IS NULL AND NOT ${qbProposedText(QB)} AND ${qbConfirmedEvidenceText(QB)})`,
    );
    expect(render(stagedStatusWhere.pending)).toBe(
      `("${QB}"."exclusion_reason" IS NULL AND NOT ${qbConfirmedEvidenceText(QB)} AND NOT ${qbResolvedElsewhereText(QB)} AND NOT ${qbIsDepositHeaderText(QB)})`,
    );
  });

  it("stripe_staged_charges fragments", () => {
    expect(render(chargeStatusSql)).toBe(chargeStatusCaseText(CH));
    expect(render(chargeCountedApplicationExists)).toBe(
      chargeCountedExistsText(CH),
    );
    expect(render(chargeStatusWhere.excluded)).toBe(
      `"${CH}"."exclusion_reason" IS NOT NULL`,
    );
    expect(render(chargeStatusWhere.match_proposed)).toBe(
      `("${CH}"."exclusion_reason" IS NULL AND ${chargeProposedText(CH)})`,
    );
    expect(render(chargeStatusWhere.match_confirmed)).toBe(
      `("${CH}"."exclusion_reason" IS NULL AND NOT ${chargeProposedText(CH)} AND ${chargeCountedExistsText(CH)})`,
    );
    expect(render(chargeStatusWhere.pending)).toBe(
      `("${CH}"."exclusion_reason" IS NULL AND NOT ${chargeCountedExistsText(CH)})`,
    );
  });
});

describe("tie consultation: booked = evidence, raw link = settlement claim", () => {
  it("the QB status CASE consults the tie exactly twice — booked (match_confirmed) and claim (excluded)", () => {
    const caseText = qbStatusCaseText("s");
    // Two tie references in the whole CASE: the BOOKED form inside the
    // confirmed-evidence arm, and the RAW-link form inside the
    // settlement-claim arm (which derives `excluded`, never confirmed).
    expect(
      caseText.split("'charge_qb_tie'").length - 1,
    ).toBe(2);
    expect(caseText).toContain(qbChargeTieBookedExistsText("s"));
    expect(caseText).toContain(qbSettlementClaimedText("s"));
    // The resolved-elsewhere arm also carries the split-parent predicate —
    // a parent with synthetic children derives `excluded` the same way.
    expect(caseText).toContain(qbHasSplitChildrenText("s"));
  });

  it("open/confirmed derivations follow the same rule", () => {
    const openText = qbOpenText("s");
    expect(openText).toContain(qbChargeTieBookedExistsText("s"));
    // Open must also carve out settlement-claimed rows (they derive excluded).
    expect(openText).toContain(qbSettlementClaimedText("s"));
    // …and split parents (same excluded derivation).
    expect(openText).toContain(qbHasSplitChildrenText("s"));
    // Charge derivations never consult the tie at all — a charge's own status
    // comes from its own ledger row, not from what it claims about a QB row.
    for (const t of [
      chargeStatusCaseText("s"),
      chargeOpenText("s"),
      chargeConfirmedText("s"),
    ]) {
      expect(t).not.toContain("charge_qb_tie");
    }
  });

  it("the QB CASE and open predicate carry the deposit_header arm (charges never do)", () => {
    const caseText = qbStatusCaseText("s");
    // The header arm sits AFTER match_confirmed and the settlement-claim arm:
    // a header named by a confirmed settlement link stays match_confirmed
    // (settled evidence); only an otherwise-bare header falls to `excluded`.
    expect(caseText).toContain(qbIsDepositHeaderText("s"));
    expect(caseText.indexOf(qbIsDepositHeaderText("s"))).toBeGreaterThan(
      caseText.indexOf(qbResolvedElsewhereText("s")),
    );
    // A header is NEVER open — it is settlement evidence, not review work.
    expect(qbOpenText("s")).toContain(
      `NOT ${qbIsDepositHeaderText("s")}`,
    );
    // Charge derivations have no entity-type concept at all.
    for (const t of [chargeStatusCaseText("s"), chargeOpenText("s")]) {
      expect(t).not.toContain("qb_entity_type");
    }
  });

  it("the booked predicate requires the tied charge's own counted booking", () => {
    const booked = qbChargeTieBookedExistsText("s");
    expect(booked).toContain(
      `"pa_ct_ds"."stripe_charge_id" = "srcl_ds"."stripe_charge_id"`,
    );
    expect(booked).toContain(`"pa_ct_ds"."link_role" = 'counted'`);
    expect(booked).toContain(`"pa_ct_ds"."evidence_source" = 'stripe'`);
  });
});
