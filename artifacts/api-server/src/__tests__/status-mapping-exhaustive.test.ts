import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { opportunityStatusEnum } from "@workspace/db/schema";
import { DERIVED_STATUSES, type DerivedStatus } from "../lib/derivedStatus";
import {
  qbCardStateOfStatus,
  type QbCardState,
} from "../routes/reconciliation/workbenchRowState";

/**
 * Status-mapping exhaustiveness guards:
 *  (a) `qbCardStateOfStatus` maps EVERY canonical DerivedStatus to its
 *      documented card state — no value may silently drift into the default
 *      "raw" branch except `pending` (the one deliberate raw case);
 *  (b) the approval write path (routes/reconciliation/approve.ts) contains no
 *      status-string comparisons against literals outside the canonical
 *      DerivedStatus vocabulary — write-path guards must branch on the fact
 *      vocabulary, never on presentation card states or ad-hoc strings.
 */

describe("qbCardStateOfStatus exhaustiveness", () => {
  const EXPECTED: Record<DerivedStatus, QbCardState> = {
    pending: "raw",
    match_proposed: "match_proposed",
    match_confirmed: "matched_complete",
    excluded: "excluded",
  };

  it("covers the full canonical status vocabulary", () => {
    expect([...DERIVED_STATUSES].sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );
  });

  it("maps every DerivedStatus to its canonical card state", () => {
    for (const status of DERIVED_STATUSES) {
      expect(qbCardStateOfStatus(status), `status=${status}`).toBe(
        EXPECTED[status],
      );
    }
  });

  it("only 'pending' (and non-statuses) fall through to 'raw'", () => {
    const rawStatuses = DERIVED_STATUSES.filter(
      (s) => qbCardStateOfStatus(s) === "raw",
    );
    expect(rawStatuses).toEqual(["pending"]);
    // Missing / unknown input falls through to raw (defensive default).
    expect(qbCardStateOfStatus(null)).toBe("raw");
    expect(qbCardStateOfStatus(undefined)).toBe("raw");
  });
});

describe("approve.ts status-literal vocabulary", () => {
  it("contains no status comparisons against strings outside DerivedStatus", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../routes/reconciliation/approve.ts", import.meta.url),
      ),
      "utf8",
    );
    // approve.ts legitimately branches on BOTH canonical vocabularies: the
    // reconciliation row status and the derived opportunity lifecycle status
    // (e.g. `opp.status === "cash_in"`). Anything outside either set is an
    // ad-hoc literal and a regression.
    const vocabulary = new Set<string>([
      ...DERIVED_STATUSES,
      ...opportunityStatusEnum.enumValues,
    ]);
    const literals = new Set<string>();
    // `<something>status === "literal"` / `!==` (any casing of *status/*Status).
    for (const m of source.matchAll(
      /\b\w*[Ss]tatus\s*[!=]==?\s*"([a-z_]+)"/g,
    )) {
      literals.add(m[1]);
    }
    // Reversed operand order: `"literal" === <something>status`.
    for (const m of source.matchAll(
      /"([a-z_]+)"\s*[!=]==?\s*\w*[Ss]tatus\b/g,
    )) {
      literals.add(m[1]);
    }
    const unknown = [...literals].filter((l) => !vocabulary.has(l));
    expect(
      unknown,
      `approve.ts compares a status against literals unknown to DERIVED_STATUSES: ${unknown.join(", ")}`,
    ).toEqual([]);
  });
});
