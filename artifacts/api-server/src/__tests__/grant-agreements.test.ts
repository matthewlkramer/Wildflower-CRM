import { describe, expect, it } from "vitest";
import { extractDriveFileId } from "../lib/googleDrive";
import {
  deriveGrantAgreement,
  resolveGrantLetterTarget,
  type CodingFormRowSelect,
} from "../lib/grantAgreements";

/**
 * Regression guards for the Drive-link grant-agreement ingest path
 * (lib/grantAgreements.ts + lib/googleDrive.ts):
 *   - extractDriveFileId handles every link shape seen in the coding-form
 *     export and returns null when nothing can be confidently extracted;
 *   - resolveGrantLetterTarget applies the single opp-else-gift-else-null rule;
 *   - deriveGrantAgreement's status ladder (na / no_match / imported /
 *     conflict / failed / ready) is computed LIVE against the target's
 *     current grant letter and never silently overwrites an existing letter.
 *
 * Pure unit tests — no DB access.
 */

const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

function makeRow(partial: Partial<CodingFormRowSelect>): CodingFormRowSelect {
  return {
    matchedOpportunityId: null,
    matchedGiftId: null,
    driveLink: null,
    grantLetterImportedUrl: null,
    grantLetterImportedFilename: null,
    grantLetterImportedAt: null,
    grantLetterImportError: null,
    ...partial,
  } as CodingFormRowSelect;
}

describe("extractDriveFileId", () => {
  it("extracts from ?id= and &id= query forms", () => {
    expect(
      extractDriveFileId(`https://drive.google.com/open?id=${FILE_ID}`),
    ).toBe(FILE_ID);
    expect(
      extractDriveFileId(
        `https://drive.google.com/uc?export=download&id=${FILE_ID}`,
      ),
    ).toBe(FILE_ID);
  });

  it("extracts from /d/<id> path forms (file + docs)", () => {
    expect(
      extractDriveFileId(`https://drive.google.com/file/d/${FILE_ID}/view`),
    ).toBe(FILE_ID);
    expect(
      extractDriveFileId(`https://docs.google.com/document/d/${FILE_ID}/edit`),
    ).toBe(FILE_ID);
  });

  it("accepts a bare id of plausible Drive length only", () => {
    expect(extractDriveFileId(FILE_ID)).toBe(FILE_ID);
    expect(extractDriveFileId(`  ${FILE_ID}  `)).toBe(FILE_ID);
    // Too short to be a Drive id.
    expect(extractDriveFileId("shortid123")).toBeNull();
  });

  it("returns null for empty / missing / prose input", () => {
    expect(extractDriveFileId(null)).toBeNull();
    expect(extractDriveFileId(undefined)).toBeNull();
    expect(extractDriveFileId("")).toBeNull();
    expect(extractDriveFileId("   ")).toBeNull();
    expect(extractDriveFileId("see the attached agreement")).toBeNull();
    expect(extractDriveFileId("https://example.com/no-drive-link")).toBeNull();
  });
});

describe("resolveGrantLetterTarget", () => {
  it("prefers the matched opportunity over the matched gift", () => {
    expect(
      resolveGrantLetterTarget({
        matchedOpportunityId: "opp1",
        matchedGiftId: "gift1",
      }),
    ).toEqual({ kind: "opportunity", id: "opp1" });
  });

  it("falls back to the matched gift when there is no opportunity", () => {
    expect(
      resolveGrantLetterTarget({
        matchedOpportunityId: null,
        matchedGiftId: "gift1",
      }),
    ).toEqual({ kind: "gift", id: "gift1" });
  });

  it("returns null when nothing is matched", () => {
    expect(
      resolveGrantLetterTarget({
        matchedOpportunityId: null,
        matchedGiftId: null,
      }),
    ).toBeNull();
  });
});

describe("deriveGrantAgreement", () => {
  const LINK = `https://drive.google.com/open?id=${FILE_ID}`;

  it("is 'na' when the row has no Drive link (even with a match)", () => {
    const view = deriveGrantAgreement(
      makeRow({ matchedOpportunityId: "opp1", driveLink: null }),
      { grantLetterUrl: null, grantLetterFilename: null },
    );
    expect(view.status).toBe("na");
    // Whitespace-only links count as no link.
    expect(
      deriveGrantAgreement(makeRow({ driveLink: "   " }), null).status,
    ).toBe("na");
  });

  it("is 'no_match' when there is a link but no matched target", () => {
    const view = deriveGrantAgreement(makeRow({ driveLink: LINK }), null);
    expect(view.status).toBe("no_match");
    expect(view.targetType).toBeNull();
    expect(view.driveFileId).toBe(FILE_ID);
  });

  it("is 'ready' when the target has no letter yet", () => {
    const view = deriveGrantAgreement(
      makeRow({ driveLink: LINK, matchedGiftId: "gift1" }),
      { grantLetterUrl: null, grantLetterFilename: null },
    );
    expect(view.status).toBe("ready");
    expect(view.targetType).toBe("gift");
  });

  it("is 'imported' (idempotent no-op) when our imported file is still attached", () => {
    const view = deriveGrantAgreement(
      makeRow({
        driveLink: LINK,
        matchedOpportunityId: "opp1",
        grantLetterImportedUrl: "https://storage/letter.pdf",
      }),
      {
        grantLetterUrl: "https://storage/letter.pdf",
        grantLetterFilename: "letter.pdf",
      },
    );
    expect(view.status).toBe("imported");
  });

  it("is 'conflict' when the target carries a DIFFERENT letter — never overwrite", () => {
    const view = deriveGrantAgreement(
      makeRow({
        driveLink: LINK,
        matchedOpportunityId: "opp1",
        grantLetterImportedUrl: "https://storage/ours.pdf",
      }),
      {
        grantLetterUrl: "https://storage/theirs.pdf",
        grantLetterFilename: "theirs.pdf",
      },
    );
    expect(view.status).toBe("conflict");
    expect(view.oppExistingUrl).toBe("https://storage/theirs.pdf");
  });

  it("is 'failed' when the last attempt errored and nothing is attached", () => {
    const view = deriveGrantAgreement(
      makeRow({
        driveLink: LINK,
        matchedGiftId: "gift1",
        grantLetterImportError: "fetch failed: 403",
      }),
      { grantLetterUrl: null, grantLetterFilename: null },
    );
    expect(view.status).toBe("failed");
    expect(view.error).toBe("fetch failed: 403");
  });
});
