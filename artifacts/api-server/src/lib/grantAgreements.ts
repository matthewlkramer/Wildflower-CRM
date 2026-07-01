import { db } from "@workspace/db";
import { codingFormRows, opportunitiesAndPledges } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { ObjectStorageService } from "./objectStorage";
import { applyDerivedOppFields } from "./pledgeStage";
import {
  DriveLinkError,
  extractDriveFileId,
  fetchDriveFile,
} from "./googleDrive";
import { logger } from "./logger";

/**
 * Grant-agreement document backfill (Task #485). Resolves the Drive link captured
 * on a coding-form row, validates + uploads the file to object storage, and attaches
 * it to the matched OPPORTUNITY/PLEDGE through the normal grant-letter flow
 * (`applyDerivedOppFields`, which re-derives status / the written-pledge latch).
 * Grant letters live on opportunities/pledges — NEVER on gifts.
 *
 * Compare-don't-clobber + idempotent: an existing, different grant letter is a
 * `conflict` (kept until the reviewer explicitly chooses replace); a re-run of a
 * row we already imported is a no-op; a fetch failure is recorded on the row so
 * the reviewer can see which links failed without re-fetching.
 */

export type CodingFormRowSelect = typeof codingFormRows.$inferSelect;

export type GrantAgreementStatus =
  | "na" // no Drive link on this row
  | "no_match" // has a link but no matched opportunity to attach it to
  | "ready" // has a link + matched opp with no grant letter → will attach
  | "imported" // we attached this file and it is still on the opp (idempotent)
  | "conflict" // the matched opp already has a DIFFERENT grant letter
  | "failed"; // last fetch/upload attempt errored (recorded on the row)

export interface GrantAgreementView {
  status: GrantAgreementStatus;
  driveFileId: string | null;
  importedUrl: string | null;
  importedFilename: string | null;
  importedAt: string | null;
  oppExistingUrl: string | null;
  oppExistingFilename: string | null;
  error: string | null;
}

interface OppGrantLetter {
  grantLetterUrl: string | null;
  grantLetterFilename: string | null;
}

/** Load the matched opportunity's grant-letter fields (null when unmatched). */
export async function loadOppGrantLetter(
  oppId: string | null,
): Promise<OppGrantLetter | null> {
  if (!oppId) return null;
  const r = await db
    .select({
      grantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
      grantLetterFilename: opportunitiesAndPledges.grantLetterFilename,
    })
    .from(opportunitiesAndPledges)
    .where(eq(opportunitiesAndPledges.id, oppId))
    .then((x) => x[0] ?? null);
  return r;
}

/**
 * Derive the per-row grant-agreement view (computed LIVE on read against the
 * matched opp's current grant letter, so it never goes stale).
 */
export function deriveGrantAgreement(
  row: CodingFormRowSelect,
  opp: OppGrantLetter | null,
): GrantAgreementView {
  const base = {
    driveFileId: extractDriveFileId(row.driveLink),
    importedUrl: row.grantLetterImportedUrl ?? null,
    importedFilename: row.grantLetterImportedFilename ?? null,
    importedAt: row.grantLetterImportedAt?.toISOString() ?? null,
    oppExistingUrl: opp?.grantLetterUrl ?? null,
    oppExistingFilename: opp?.grantLetterFilename ?? null,
    error: row.grantLetterImportError ?? null,
  };

  const hasLink = !!(row.driveLink && row.driveLink.trim().length > 0);
  if (!hasLink) return { ...base, status: "na" };
  if (!row.matchedOpportunityId || !opp)
    return { ...base, status: "no_match" };

  const oppUrl = opp.grantLetterUrl;
  const ourUrl = row.grantLetterImportedUrl;
  // We attached this exact file and it is still on the opp → idempotent skip.
  if (ourUrl && oppUrl === ourUrl) return { ...base, status: "imported" };
  // The opp already has a (different) grant letter → never silently overwrite.
  if (oppUrl) return { ...base, status: "conflict" };
  // A prior attempt failed (and nothing is attached) → surface the error.
  if (row.grantLetterImportError) return { ...base, status: "failed" };
  return { ...base, status: "ready" };
}

export type PullGrantAgreementResult =
  | { kind: "imported"; replaced: boolean }
  | { kind: "already_imported" }
  | { kind: "conflict" } // existing letter, replace not requested → 409
  | { kind: "no_link" } // no Drive link on the row → 409
  | { kind: "no_match" } // no matched opportunity → 409
  | { kind: "failed"; reason: string; error: string }; // recorded per-row

const ERROR_LABELS: Record<string, string> = {
  unparseable: "The captured Drive link has no recognizable file id.",
  not_found: "The Drive file no longer exists (404).",
  permission:
    "The connected Google account can't read this file (permission denied).",
  trashed: "The Drive file is in the trash.",
  unsupported_type:
    "The Drive file isn't a supported document type (PDF, image, or Word).",
  empty: "The Drive file downloaded as empty.",
  fetch_failed: "Couldn't fetch the Drive file (transient error).",
};

/**
 * Pull one row's grant-agreement file and attach it to the matched opportunity.
 * Returns a discriminated result the route maps to HTTP codes. A Drive fetch
 * failure is recorded on the row and returned as `failed` (not thrown) so the
 * reviewer can see it inline; only a missing connector / unexpected error
 * propagates.
 */
export async function pullGrantAgreement(
  row: CodingFormRowSelect,
  opts: { replace: boolean; userId: string | null },
): Promise<PullGrantAgreementResult> {
  const driveLink = row.driveLink?.trim();
  if (!driveLink) return { kind: "no_link" };
  if (!row.matchedOpportunityId) return { kind: "no_match" };

  const opp = await loadOppGrantLetter(row.matchedOpportunityId);
  if (!opp) return { kind: "no_match" };

  // Idempotency: we already attached this exact file and it is still there.
  if (
    row.grantLetterImportedUrl &&
    opp.grantLetterUrl === row.grantLetterImportedUrl
  ) {
    return { kind: "already_imported" };
  }

  // Conflict: a DIFFERENT existing grant letter — never silently overwrite.
  const replacing = !!opp.grantLetterUrl;
  if (replacing && !opts.replace) return { kind: "conflict" };

  const fileId = extractDriveFileId(driveLink);
  if (!fileId) {
    await recordError(row.id, "unparseable", "no extractable Drive file id");
    return {
      kind: "failed",
      reason: "unparseable",
      error: ERROR_LABELS.unparseable,
    };
  }

  // Fetch + validate the document (recoverable per-row errors are recorded).
  let file;
  try {
    file = await fetchDriveFile(fileId);
  } catch (err) {
    if (err instanceof DriveLinkError) {
      await recordError(row.id, err.reason, err.message);
      return {
        kind: "failed",
        reason: err.reason,
        error: ERROR_LABELS[err.reason] ?? err.message,
      };
    }
    throw err; // DriveNotConfiguredError / unexpected → 5xx
  }

  // Upload to object storage via a presigned PUT (server-side), mirroring the
  // grant-letter-upload component's client flow.
  const storage = new ObjectStorageService();
  const uploadURL = await storage.getObjectEntityUploadURL();
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.bytes.length),
    },
    body: file.bytes,
  });
  if (!putRes.ok) {
    const msg = `object-storage upload HTTP ${putRes.status}`;
    await recordError(row.id, "fetch_failed", msg);
    return { kind: "failed", reason: "fetch_failed", error: msg };
  }
  const objectPath = storage.normalizeObjectEntityPath(uploadURL);
  const grantLetterUrl = `/api/storage${objectPath}`;

  // Attach to the matched opportunity through the derive-aware path so the
  // written-pledge latch / status stay correct. Stamp uploadedAt explicitly
  // (the opp PATCH does not auto-stamp it).
  await db
    .update(opportunitiesAndPledges)
    .set({
      grantLetterUrl,
      grantLetterFilename: file.filename,
      grantLetterUploadedAt: new Date().toISOString(),
      updatedAt: new Date(),
    })
    .where(eq(opportunitiesAndPledges.id, row.matchedOpportunityId));
  await applyDerivedOppFields(row.matchedOpportunityId);

  // Record what we attached (idempotency marker) + clear any prior error.
  await db
    .update(codingFormRows)
    .set({
      grantLetterImportedUrl: grantLetterUrl,
      grantLetterImportedFilename: file.filename,
      grantLetterImportedAt: new Date(),
      grantLetterImportError: null,
      updatedAt: new Date(),
    })
    .where(eq(codingFormRows.id, row.id));

  logger.info(
    { rowId: row.id, oppId: row.matchedOpportunityId, replaced: replacing },
    "Attached grant-agreement file to opportunity",
  );
  return { kind: "imported", replaced: replacing };
}

async function recordError(
  rowId: string,
  reason: string,
  detail: string,
): Promise<void> {
  await db
    .update(codingFormRows)
    .set({
      grantLetterImportError: `${reason}: ${detail}`,
      updatedAt: new Date(),
    })
    .where(eq(codingFormRows.id, rowId));
}
