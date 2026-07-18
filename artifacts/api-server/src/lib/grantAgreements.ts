import { db } from "@workspace/db";
import {
  codingFormRows,
  giftsAndPayments,
  opportunitiesAndPledges,
} from "@workspace/db/schema";
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
 * Grant-agreement document backfill (Task #485, reworked for record-first
 * matching). Resolves the Drive link captured on a coding-form row, validates +
 * uploads the file to object storage, and attaches it to the matched
 * OPPORTUNITY/PLEDGE when there is one (through the derive-aware grant-letter
 * flow — `applyDerivedOppFields` re-derives status / the written-pledge latch),
 * ELSE to the matched GIFT (gifts carry mirror `grant_letter_*` columns; a
 * letter on a gift never affects pledge/status derivation).
 *
 * Compare-don't-clobber + idempotent: an existing, different grant letter is a
 * `conflict` (kept until the reviewer explicitly chooses replace); a re-run of a
 * row we already imported is a no-op; a fetch failure is recorded on the row so
 * the reviewer can see which links failed without re-fetching.
 */

export type CodingFormRowSelect = typeof codingFormRows.$inferSelect;

export type GrantAgreementStatus =
  | "na" // no Drive link on this row
  | "no_match" // has a link but no matched opportunity OR gift to attach it to
  | "ready" // has a link + matched target with no grant letter → will attach
  | "imported" // we attached this file and it is still on the target (idempotent)
  | "conflict" // the matched target already has a DIFFERENT grant letter
  | "failed"; // last fetch/upload attempt errored (recorded on the row)

export interface GrantAgreementView {
  status: GrantAgreementStatus;
  /** Where the letter goes: opp when matched, else gift, else null. */
  targetType: "opportunity" | "gift" | null;
  driveFileId: string | null;
  importedUrl: string | null;
  importedFilename: string | null;
  importedAt: string | null;
  // Existing letter on the TARGET (opp or gift — field names kept for API
  // compatibility with the pre-rework opp-only shape).
  oppExistingUrl: string | null;
  oppExistingFilename: string | null;
  error: string | null;
}

interface GrantLetterFields {
  grantLetterUrl: string | null;
  grantLetterFilename: string | null;
}

export interface GrantLetterTarget {
  kind: "opportunity" | "gift";
  id: string;
}

/** Opp when matched, else gift, else null — the single opp-else-gift rule. */
export function resolveGrantLetterTarget(
  row: Pick<CodingFormRowSelect, "matchedOpportunityId" | "matchedGiftId">,
): GrantLetterTarget | null {
  if (row.matchedOpportunityId)
    return { kind: "opportunity", id: row.matchedOpportunityId };
  if (row.matchedGiftId) return { kind: "gift", id: row.matchedGiftId };
  return null;
}

/** Load the target's current grant-letter fields (null when no target/row gone). */
export async function loadTargetGrantLetter(
  target: GrantLetterTarget | null,
): Promise<GrantLetterFields | null> {
  if (!target) return null;
  if (target.kind === "opportunity") {
    return db
      .select({
        grantLetterUrl: opportunitiesAndPledges.grantLetterUrl,
        grantLetterFilename: opportunitiesAndPledges.grantLetterFilename,
      })
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.id, target.id))
      .then((x) => x[0] ?? null);
  }
  return db
    .select({
      grantLetterUrl: giftsAndPayments.grantLetterUrl,
      grantLetterFilename: giftsAndPayments.grantLetterFilename,
    })
    .from(giftsAndPayments)
    .where(eq(giftsAndPayments.id, target.id))
    .then((x) => x[0] ?? null);
}

/**
 * Derive the per-row grant-agreement view (computed LIVE on read against the
 * target's current grant letter, so it never goes stale). `letter` must be the
 * fields loaded for `resolveGrantLetterTarget(row)`.
 */
export function deriveGrantAgreement(
  row: CodingFormRowSelect,
  letter: GrantLetterFields | null,
): GrantAgreementView {
  const target = resolveGrantLetterTarget(row);
  const base = {
    targetType: target?.kind ?? null,
    driveFileId: extractDriveFileId(row.driveLink),
    importedUrl: row.grantLetterImportedUrl ?? null,
    importedFilename: row.grantLetterImportedFilename ?? null,
    importedAt: row.grantLetterImportedAt?.toISOString() ?? null,
    oppExistingUrl: letter?.grantLetterUrl ?? null,
    oppExistingFilename: letter?.grantLetterFilename ?? null,
    error: row.grantLetterImportError ?? null,
  };

  const hasLink = !!(row.driveLink && row.driveLink.trim().length > 0);
  if (!hasLink) return { ...base, status: "na" };
  if (!target || !letter) return { ...base, status: "no_match" };

  const existingUrl = letter.grantLetterUrl;
  const ourUrl = row.grantLetterImportedUrl;
  // We attached this exact file and it is still on the target → idempotent skip.
  if (ourUrl && existingUrl === ourUrl) return { ...base, status: "imported" };
  // The target already has a (different) grant letter → never silently overwrite.
  if (existingUrl) return { ...base, status: "conflict" };
  // A prior attempt failed (and nothing is attached) → surface the error.
  if (row.grantLetterImportError) return { ...base, status: "failed" };
  return { ...base, status: "ready" };
}

export type PullGrantAgreementResult =
  | { kind: "imported"; replaced: boolean; target: GrantLetterTarget }
  | { kind: "already_imported" }
  | { kind: "conflict" } // existing letter, replace not requested → 409
  | { kind: "no_link" } // no Drive link on the row → 409
  | { kind: "no_match" } // no matched opportunity or gift → 409
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
 * Pull one row's grant-agreement file and attach it to the matched opportunity
 * when there is one, else the matched gift. Returns a discriminated result the
 * route maps to HTTP codes. A Drive fetch failure is recorded on the row and
 * returned as `failed` (not thrown) so the reviewer can see it inline; only a
 * missing connector / unexpected error propagates.
 */
export async function pullGrantAgreement(
  row: CodingFormRowSelect,
  opts: { replace: boolean; userId: string | null },
): Promise<PullGrantAgreementResult> {
  const driveLink = row.driveLink?.trim();
  if (!driveLink) return { kind: "no_link" };
  const target = resolveGrantLetterTarget(row);
  if (!target) return { kind: "no_match" };

  const letter = await loadTargetGrantLetter(target);
  if (!letter) return { kind: "no_match" };

  // Idempotency: we already attached this exact file and it is still there.
  if (
    row.grantLetterImportedUrl &&
    letter.grantLetterUrl === row.grantLetterImportedUrl
  ) {
    return { kind: "already_imported" };
  }

  // Conflict: a DIFFERENT existing grant letter — never silently overwrite.
  const replacing = !!letter.grantLetterUrl;
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

  // Attach to the target. Opportunities go through the derive-aware path so
  // the written-pledge latch / status stay correct (stamp uploadedAt
  // explicitly — the opp PATCH does not auto-stamp it). Gift letters are a
  // plain document attach: they never feed pledge/status derivation.
  if (target.kind === "opportunity") {
    await db
      .update(opportunitiesAndPledges)
      .set({
        grantLetterUrl,
        grantLetterFilename: file.filename,
        grantLetterUploadedAt: new Date().toISOString(),
        updatedAt: new Date(),
      })
      .where(eq(opportunitiesAndPledges.id, target.id));
    await applyDerivedOppFields(target.id);
  } else {
    await db
      .update(giftsAndPayments)
      .set({
        grantLetterUrl,
        grantLetterFilename: file.filename,
        grantLetterUploadedAt: new Date().toISOString(),
        updatedAt: new Date(),
      })
      .where(eq(giftsAndPayments.id, target.id));
  }

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
    {
      rowId: row.id,
      targetType: target.kind,
      targetId: target.id,
      replaced: replacing,
    },
    "Attached grant-agreement file",
  );
  return { kind: "imported", replaced: replacing, target };
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
