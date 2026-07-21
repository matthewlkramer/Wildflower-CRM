import { describe, expect, it } from "vitest";
import { parseCsv, parseFormSheet } from "@workspace/coding-forms";

/**
 * FY27 live-sheet parsing: the FY27 Google Sheet's header is the FIRST row
 * (unlike FY25/FY26 which have junk rows above it), and its column headers all
 * match the existing shared HEADER_MATCHERS — no new mapping logic, only the
 * new source + header-row index. Also covers the CSV → row-array conversion
 * used by the daily sheet fetch.
 */

// The real FY27 column headers (verbatim from the live sheet's form).
const FY27_HEADERS = [
  "Timestamp",
  "Email Address",
  "Person filling out this form",
  "Name of Donor",
  "Amount",
  "Fees charged (if any)",
  "Circle",
  "Date deposited",
  "Grant agreement upload (if any)",
  "Internal memo",
  "Type of donor",
  "Stand-alone gift or multi-series?",
  "Additional notes",
  "Restriction language (if any)",
  "Name and address of donor",
  "Does this grant require a written report? If yes, by what date?",
];

function fy27Row(overrides: Partial<Record<number, string | null>> = {}) {
  const row: (string | null)[] = [
    "7/15/2026 10:12:33",
    "staff@wildflowerschools.org",
    "Jane Staff",
    "Alexander Brown",
    "$150",
    null,
    "Massachusetts",
    "7/14/2026",
    null,
    "General support",
    "Individual",
    "Stand-alone",
    null,
    null,
    "Alexander Brown, 12 Main St, Boston, MA 02110",
    "No",
  ];
  for (const [k, v] of Object.entries(overrides)) row[Number(k)] = v ?? null;
  return row;
}

describe("parseFormSheet('fy27', …)", () => {
  it("maps the real FY27 column set with header row 0", () => {
    const rows = parseFormSheet("fy27", [
      FY27_HEADERS,
      fy27Row(),
      fy27Row({ 3: "Erica Cantoni", 4: "104.70", 10: "Individual" }),
    ]);
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a.source).toBe("fy27");
    expect(a.sourceRowIndex).toBe(0);
    expect(a.donorNameRaw).toBe("Alexander Brown");
    expect(a.amount).toBe("150.00");
    expect(a.donationDate).toBe("2026-07-15");
    expect(a.depositDate).toBe("2026-07-14");
    expect(a.submitterEmail).toBe("staff@wildflowerschools.org");
    expect(a.wildflowerPartner).toBe("Jane Staff");
    expect(a.circleRaw).toBe("Massachusetts");
    expect(a.internalMemo).toBe("General support");
    expect(a.donorTypeRaw).toBe("Individual");
    expect(a.seriesTypeRaw).toBe("Stand-alone");
    expect(a.reportRequired).toBe(false);
    expect(a.addrCity).toBe("Boston");
    expect(a.addrState).toBe("MA");
    expect(a.addrPostal).toBe("02110");
    expect(b.sourceRowIndex).toBe(1);
    expect(b.donorNameRaw).toBe("Erica Cantoni");
    expect(b.amount).toBe("104.70");
  });

  it("skips blank and Test rows without consuming a data index", () => {
    const rows = parseFormSheet("fy27", [
      FY27_HEADERS,
      fy27Row({ 3: "Test" }),
      fy27Row({ 3: null }),
      fy27Row({ 3: "Real Donor" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].donorNameRaw).toBe("Real Donor");
    expect(rows[0].sourceRowIndex).toBe(0);
  });
});

describe("parseCsv", () => {
  it("parses quoted fields with embedded commas, quotes, and newlines", () => {
    const csv = 'a,"b,1","say ""hi""","line1\nline2"\r\nc,,d,\n';
    expect(parseCsv(csv)).toEqual([
      ["a", "b,1", 'say "hi"', "line1\nline2"],
      ["c", null, "d", null],
    ]);
  });

  it("strips a UTF-8 BOM and handles a trailing newline without a phantom row", () => {
    expect(parseCsv("\uFEFFx,y\n1,2\n")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("round-trips through parseFormSheet", () => {
    const csv =
      FY27_HEADERS.map((h) => `"${h}"`).join(",") +
      "\n" +
      '7/15/2026 10:12:33,staff@x.org,Jane,"Brown, Alexander",$150,,MA,7/14/2026,,memo,Individual,Stand-alone,,,addr,No';
    const rows = parseFormSheet("fy27", parseCsv(csv));
    expect(rows).toHaveLength(1);
    expect(rows[0].donorNameRaw).toBe("Brown, Alexander");
    expect(rows[0].amount).toBe("150.00");
  });
});
