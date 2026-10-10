import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  splitCombinedOrganization,
  classifyImportRow,
  mapDocument,
  MAX_IMPORT_BYTES,
  readImportDocument,
} from "../lib/conferenceImportDocument";

const orgs = [
  {
    id: "o1",
    name: "North Harbor Foundation",
    historicalNames: ["Harbor Trust"],
  },
  { id: "o2", name: "Civic Learning Alliance", historicalNames: [] },
];
const persons = [
  { id: "p1", name: "Alex Chen", organizationIds: ["o1"], emails: [] },
  { id: "p2", name: "Alex Chen", organizationIds: ["o2"], emails: [] },
  {
    id: "p3",
    name: "Jordan Park",
    organizationIds: [],
    emails: ["jordan@example.org"],
  },
];
describe("conference directory documents", () => {
  it("bounds XLSX expansion and accepts a synthetic 755-row directory", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Name"], ["Synthetic Person"]]),
      "Directory",
    );
    const zip = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const directory = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(21 * 1024 * 1024, directory + 24);
    expect(() =>
      readImportDocument({
        filename: "large.xlsx",
        fileBase64: zip.toString("base64"),
      }),
    ).toThrow("expansion");
    const csvText =
      "Name\n" +
      Array.from({ length: 755 }, (_, i) => `Synthetic Person ${i}`).join("\n");
    expect(mapDocument(readImportDocument({ csvText }))).toHaveLength(755);
  });
  it("preserves original cells, combined text and source row numbers in CSV and XLSX", () => {
    const matrix = [
      ["Displayed name", "Displayed title / organization", "Employer"],
      ["Alex Chen", "Program Officer, North Harbor", "Harbor Trust"],
      ["", "", ""],
      ["Robin Ames", "Director\nPartnerships", "Civic Learning Alliance"],
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(matrix),
      "Directory",
    );
    const xlsx = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const csv =
      'Displayed name,Displayed title / organization,Employer\r\nAlex Chen,"Program Officer, North Harbor",Harbor Trust\r\n,,\r\nRobin Ames,"Director\nPartnerships",Civic Learning Alliance';
    const a = mapDocument(readImportDocument({ csvText: csv }), {
      name: 0,
      organization: 2,
    });
    const b = mapDocument(
      readImportDocument({
        filename: "directory.xlsx",
        fileBase64: xlsx.toString("base64"),
      }),
      { name: 0, organization: 2 },
    );
    expect(a).toEqual(b);
    expect(a.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(a[0].rawTitle).toBeNull();
    expect(a[0].rawCells[1]).toBe("Program Officer, North Harbor");
  });
  it("rejects malformed contents, invalid mappings, unsupported extensions and oversized inputs", () => {
    expect(() =>
      readImportDocument({ csvText: 'Name\n"unterminated' }),
    ).toThrow("Unclosed");
    expect(() =>
      readImportDocument({
        filename: "x.xlsx",
        fileBase64: Buffer.from("not a ZIP").toString("base64"),
      }),
    ).toThrow("XLSX");
    expect(() =>
      readImportDocument({ csvText: "x".repeat(MAX_IMPORT_BYTES + 1) }),
    ).toThrow("2 MiB");
    expect(() =>
      readImportDocument({ csvText: "Name\nAlex", filename: "file.pdf" }),
    ).toThrow("CSV and XLSX");
    expect(() =>
      readImportDocument({ csvText: "Name\nAlex", fileBase64: "AAAA" }),
    ).toThrow("one CSV");
    expect(() =>
      mapDocument(readImportDocument({ csvText: "Name,Org\nAlex,Harbor" }), {
        name: 0,
        organization: 0,
      }),
    ).toThrow("different column");
    expect(() =>
      mapDocument(readImportDocument({ csvText: "Person\nAlex" })),
    ).toThrow("valid columns");
  });
  it("matches without email only with unique organization corroboration and handles duplicate names", () => {
    expect(
      classifyImportRow(
        {
          rawName: "Alex Chen",
          rawOrganization: "The Harbor Trust",
          rawEmail: null,
        },
        persons,
        orgs,
      ),
    ).toMatchObject({ matchedPersonId: "p1", category: "reliable" });
    expect(
      classifyImportRow(
        { rawName: "Alex Chen", rawOrganization: null, rawEmail: null },
        persons,
        orgs,
      ),
    ).toMatchObject({ matchedPersonId: null, category: "ambiguous" });
    expect(
      classifyImportRow(
        {
          rawName: "New Contact",
          rawOrganization: "Civic Learning Alliance",
          rawEmail: null,
        },
        persons,
        orgs,
      ).category,
    ).toBe("new_person_existing_org");
  });
  it("does not infer foundation status from a name or choose an ambiguous organization", () => {
    expect(
      classifyImportRow(
        {
          rawName: "Robin Ames",
          rawOrganization: "Mystery Foundation",
          rawEmail: null,
        },
        persons,
        orgs,
      ).category,
    ).toBe("other_unmatched");
    expect(
      classifyImportRow(
        {
          rawName: "Robin Ames",
          rawOrganization: "Harbor Trust",
          rawEmail: null,
        },
        persons,
        [...orgs, { id: "o3", name: "Harbor Trust", historicalNames: [] }],
      ).category,
    ).toBe("ambiguous");
    expect(
      classifyImportRow(
        {
          rawName: "Wrong Identity",
          rawEmail: "jordan@example.org",
          rawOrganization: null,
        },
        persons,
        orgs,
      ).category,
    ).toBe("ambiguous");
    expect(
      classifyImportRow(
        { rawName: "", rawEmail: null, rawOrganization: null },
        persons,
        orgs,
      ).reviewError,
    ).toBe("Missing name.");
  });
});

describe("combined displayed affiliation", () => {
  it("matches a complete CRM suffix without splitting commas inside title or organization", () => {
    expect(
      splitCombinedOrganization(
        "Senior Director, Programs, North Harbor Foundation",
        orgs,
      ),
    ).toMatchObject({
      proposedTitle: "Senior Director, Programs",
      proposedOrganization: "North Harbor Foundation",
      splitNeedsReview: false,
    });
    expect(
      splitCombinedOrganization("Program Officer, Harbor Trust", orgs),
    ).toMatchObject({
      proposedTitle: "Program Officer",
      proposedOrganization: "Harbor Trust",
      splitNeedsReview: false,
    });
    expect(
      splitCombinedOrganization("Civic Learning Alliance", orgs),
    ).toMatchObject({
      proposedTitle: null,
      proposedOrganization: "Civic Learning Alliance",
      splitNeedsReview: false,
    });
    expect(
      splitCombinedOrganization("Director, Community, Inc.", [
        { id: "comma", name: "Community, Inc.", historicalNames: [] },
      ]),
    ).toMatchObject({
      proposedTitle: "Director",
      proposedOrganization: "Community, Inc.",
      splitNeedsReview: false,
    });
  });
  it("leaves uncertain boundaries and foundation eligibility for review", () => {
    expect(
      splitCombinedOrganization("Program Officer, Mystery Foundation", orgs),
    ).toMatchObject({
      proposedTitle: "Program Officer",
      proposedOrganization: "Mystery Foundation",
      splitNeedsReview: true,
    });
    expect(
      splitCombinedOrganization("Director, Programs, Unknown Group", orgs),
    ).toMatchObject({ proposedOrganization: null, splitNeedsReview: true });
    expect(
      splitCombinedOrganization("Director, North Harbor Foundation", [
        ...orgs,
        { id: "other", name: "North Harbor Foundation", historicalNames: [] },
      ]),
    ).toMatchObject({ proposedOrganization: null, splitNeedsReview: true });
    expect(splitCombinedOrganization("Unknown Group", orgs)).toMatchObject({
      proposedOrganization: null,
      splitNeedsReview: true,
    });
  });
});
