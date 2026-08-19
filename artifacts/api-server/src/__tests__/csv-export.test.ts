import { describe, expect, it } from "vitest";
import {
  csvCell,
  csvFilename,
  labelizeEnum,
  neutralizeFormula,
  stringifyCsvValue,
  toCsv,
} from "../lib/csvExport";
import {
  GIFT_EXPORT_FIELDS,
  OPPORTUNITY_EXPORT_FIELDS,
  ORGANIZATION_EXPORT_FIELDS,
  PEOPLE_EXPORT_FIELDS,
  parseFieldsParam,
  selectExportFields,
} from "../lib/csvExportFields";

describe("neutralizeFormula", () => {
  it("prefixes formula-looking cells with a quote", () => {
    expect(neutralizeFormula("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(neutralizeFormula("+1234")).toBe("'+1234");
    expect(neutralizeFormula("-5")).toBe("'-5");
    expect(neutralizeFormula("@cmd")).toBe("'@cmd");
    expect(neutralizeFormula("\tx")).toBe("'\tx");
  });
  it("leaves normal values alone", () => {
    expect(neutralizeFormula("Jane Doe")).toBe("Jane Doe");
    expect(neutralizeFormula("100")).toBe("100");
    expect(neutralizeFormula("")).toBe("");
  });
});

describe("csvCell", () => {
  it("quotes cells containing commas, quotes, and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });
  it("neutralizes formulas before quoting", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("=a,b")).toBe("\"'=a,b\"");
  });
  it("stringifies dates, arrays, booleans, and null", () => {
    expect(stringifyCsvValue(null)).toBe("");
    expect(stringifyCsvValue(undefined)).toBe("");
    expect(stringifyCsvValue(new Date("2026-03-04T12:00:00Z"))).toBe(
      "2026-03-04",
    );
    expect(stringifyCsvValue(["a", "b"])).toBe("a; b");
    expect(stringifyCsvValue(true)).toBe("Yes");
    expect(stringifyCsvValue(false)).toBe("No");
  });
});

describe("toCsv", () => {
  it("emits a BOM, CRLF line endings, and a header row", () => {
    const csv = toCsv(["Name", "Amount"], [["Jane", 5]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("Name,Amount\r\nJane,5\r\n");
  });
});

describe("labelizeEnum / csvFilename", () => {
  it("labelizes snake_case", () => {
    expect(labelizeEnum("donor_restricted")).toBe("Donor restricted");
    expect(labelizeEnum(null)).toBe("");
  });
  it("builds a dated filename", () => {
    expect(csvFilename("gifts")).toMatch(/^gifts-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("selectExportFields", () => {
  it("returns the full catalog when no fields requested", () => {
    expect(selectExportFields(PEOPLE_EXPORT_FIELDS, undefined)).toEqual(
      PEOPLE_EXPORT_FIELDS,
    );
  });
  it("filters to requested keys, dropping unknown keys like actions", () => {
    const picked = selectExportFields(GIFT_EXPORT_FIELDS, [
      "name",
      "amount",
      "actions",
    ]);
    expect(picked.map((f) => f.key)).toEqual(["name", "amount"]);
  });
  it("maps the priority-star alias onto priorityTier", () => {
    const picked = selectExportFields(ORGANIZATION_EXPORT_FIELDS, [
      "priority",
      "name",
    ]);
    expect(picked.map((f) => f.key)).toEqual(["name", "priorityTier"]);
  });
  it("falls back to the full catalog when only unknown keys requested", () => {
    expect(
      selectExportFields(OPPORTUNITY_EXPORT_FIELDS, ["actions"]).length,
    ).toBe(OPPORTUNITY_EXPORT_FIELDS.length);
  });
  it("parses the comma-form fields param", () => {
    expect(parseFieldsParam("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(parseFieldsParam("")).toBeUndefined();
    expect(parseFieldsParam(undefined)).toBeUndefined();
  });
});
