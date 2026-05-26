import { db } from "@workspace/db";
import {
  emailMessages,
  emailAttachments,
  emailSyncSkip,
  emailSyncState,
} from "@workspace/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import {
  getMessage,
  getAttachmentBytes,
  extractMessageParts,
  getHeader,
  parseAddressHeader,
  type GmailMessage,
} from "./gmail";
import {
  getValidGoogleAccessTokenForUser,
  type ActiveGoogleGrant,
} from "./googleTokenStore";
import { withSyncLock } from "./syncLock";
import { matchEmails, isMatchEmpty } from "./emailMatcher";
import { uploadAttachment } from "./emailAttachmentStore";
import {
  processIntelForMatched,
  processIntelForUnmatched,
  shouldFetchFullForIntel,
} from "./emailIntelligence";
import { emailProposals, users } from "@workspace/db/schema";
import { summarizeEmail } from "./summarizeEmail";
import { proposeActionsForProposal } from "./proposeActions";

/**
 * One-time backfill orchestrator. Re-runs the matcher + email-intelligence
 * detectors over already-synced messages so users get the benefit of
 * detector / matcher capabilities that were added AFTER their initial
 * bootstrap.
 *
 * Runs under the same `gmail` advisory lock as the scheduler so it
 * can't collide with a normal scheduler tick on the same mailbox.
 * On lock contention we return `notConnected:false, ok:false,
 * error:"sync_in_progress"` and exit fast — caller can retry.
 *
 * Three phases per user (all run while we hold the lock):
 *
 *   A. Re-match skip rows. For each row in `email_sync_skip` whose
 *      participants now resolve to a CRM person / funder / household,
 *      fetch the full message from Gmail, promote it into
 *      `email_messages` with the matched-path persistence (body +
 *      attachments + matched arrays + intel), then delete the skip row.
 *
 *   B. Re-intel existing matched messages. For each row in
 *      `email_messages` we already have `body_text` / `body_html` /
 *      `from_email` / `subject` / `direction` / `matched_person_ids` —
 *      everything `processIntelForMatched` needs. No Gmail call. Cheap
 *      sweep that lets newly added detectors (e.g. grant_opportunity)
 *      pick up signals from historical mail.
 *
 *   C. Re-intel still-unmatched skip rows whose sender / subject passes
 *      `shouldFetchFullForIntel` (LinkedIn / bounce / grant digest).
 *      Fetches full from Gmail and runs `processIntelForUnmatched`.
 *      Doesn't delete the skip row — the message remains "skip"
 *      because no CRM contact is involved, intel just mines its body.
 *
 * Each phase paginates and logs a running counter so a long-running
 * backfill on a 10k+ mailbox stays observable. Per-message failures
 * are logged and counted; they don't abort the phase.
 *
 * Idempotent: re-running is safe. Phase A's promotion is ON CONFLICT
 * DO NOTHING so an already-promoted row is skipped. Phases B and C
 * write proposals via `upsertProposal` which dedupes on
 * `(mailbox_user_id, dedupe_key)` with the partial unique index.
 */

const PAGE = 500;

export interface BackfillReport {
  phaseA: { scanned: number; promoted: number; errors: number };
  phaseB: { scanned: number; ranIntel: number; errors: number };
  phaseC: { scanned: number; ranIntel: number; errors: number };
  phaseD: { scanned: number; analyzed: number; errors: number };
}

export interface BackfillOutcome {
  ok: boolean;
  notConnected?: boolean;
  error?: string;
  report?: BackfillReport;
}

export async function backfillIntelForUser(
  userId: string,
): Promise<BackfillOutcome> {
  const grant = await getValidGoogleAccessTokenForUser(userId);
  if (!grant) return { ok: false, notConnected: true };

  const lockOutcome = await withSyncLock(userId, "gmail", async () => {
    const report: BackfillReport = {
      phaseA: { scanned: 0, promoted: 0, errors: 0 },
      phaseB: { scanned: 0, ranIntel: 0, errors: 0 },
      phaseC: { scanned: 0, ranIntel: 0, errors: 0 },
      phaseD: { scanned: 0, analyzed: 0, errors: 0 },
    };
    try {
      // Resolve the owner's privacy mode ONCE at the start of the
      // backfill run. In `summary_only` mode we still run phase A
      // (so newly-matching contacts get promoted to a message row,
      // just with a summary instead of a body), but phases B + C +
      // D are skipped wholesale because they re-run body-derived
      // intelligence and proposals — exactly what the user opted
      // out of. Phase A is the only one that can produce new
      // visible activity in the contact timeline; B/C/D are
      // body-mining sweeps the user has declined.
      const ownerRow = await db
        .select({ mode: users.emailSyncMode })
        .from(users)
        .where(eq(users.id, userId))
        .then((r) => r[0]);
      const summaryOnly = ownerRow?.mode === "summary_only";
      logger.info(
        { userId, summaryOnly },
        "Backfill starting (phase A: re-match skips)",
      );
      await phaseA(grant, report, summaryOnly);
      logger.info(
        { userId, phaseA: report.phaseA },
        summaryOnly
          ? "Backfill phase A done; skipping phases B/C/D (summary_only mode)"
          : "Backfill phase A done; starting phase B (re-intel matched)",
      );
      if (!summaryOnly) {
        await phaseB(userId, grant.googleEmail, report);
        logger.info(
          { userId, phaseB: report.phaseB },
          "Backfill phase B done; starting phase C (re-intel skips via full-fetch gate)",
        );
        await phaseC(grant, report);
        logger.info(
          { userId, phaseC: report.phaseC },
          "Backfill phase C done; starting phase D (AI action proposal for pending rows)",
        );
        await phaseD(userId, report);
      }
      // Stamp backfill_completed_at so the scheduler's auto-trigger
      // doesn't immediately re-fire this on the next tick. A row
      // exists in email_sync_state by the time bootstrap has run, so
      // a plain UPDATE is safe (no upsert needed).
      await db
        .update(emailSyncState)
        .set({ backfillCompletedAt: new Date(), updatedAt: new Date() })
        .where(eq(emailSyncState.mailboxUserId, userId));
      logger.info({ userId, report }, "Backfill complete");
      return { ok: true as const, report };
    } catch (err) {
      logger.error({ err, userId, report }, "Backfill aborted");
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        report,
      };
    }
  });

  if (!lockOutcome.ran) {
    logger.warn(
      { userId },
      "Backfill skipped: gmail sync lock held by another worker",
    );
    return { ok: false, error: "sync_in_progress" };
  }
  return lockOutcome.result!;
}

// ---------------------------------------------------------------------------
// Phase A: re-match skips, promote to matched
// ---------------------------------------------------------------------------

async function phaseA(
  grant: ActiveGoogleGrant,
  report: BackfillReport,
  summaryOnly: boolean,
): Promise<void> {
  // Cursor by gmailMessageId so a row promoted (deleted) mid-pass
  // doesn't cause us to skip the next row.
  let cursor: string | null = null;
  while (true) {
    const rows: Array<{
      gmailMessageId: string;
      fromAddrs: string[];
      toAddrs: string[];
      ccAddrs: string[];
      bccAddrs: string[];
    }> = await db
      .select({
        gmailMessageId: emailSyncSkip.gmailMessageId,
        fromAddrs: emailSyncSkip.fromAddrs,
        toAddrs: emailSyncSkip.toAddrs,
        ccAddrs: emailSyncSkip.ccAddrs,
        bccAddrs: emailSyncSkip.bccAddrs,
      })
      .from(emailSyncSkip)
      .where(
        cursor
          ? and(
              eq(emailSyncSkip.mailboxUserId, grant.userId),
              sql`${emailSyncSkip.gmailMessageId} > ${cursor}`,
            )
          : eq(emailSyncSkip.mailboxUserId, grant.userId),
      )
      .orderBy(asc(emailSyncSkip.gmailMessageId))
      .limit(PAGE);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].gmailMessageId;

    for (const row of rows) {
      report.phaseA.scanned++;
      const allAddrs = [
        ...row.fromAddrs,
        ...row.toAddrs,
        ...row.ccAddrs,
        ...row.bccAddrs,
      ];
      let stillUnmatched = false;
      try {
        const match = await matchEmails(allAddrs, grant.googleEmail);
        if (isMatchEmpty(match)) {
          stillUnmatched = true;
        } else {
          const ok = await promoteSkipToMatched(grant, row.gmailMessageId, summaryOnly);
          if (ok) report.phaseA.promoted++;
          else report.phaseA.errors++;
        }
      } catch (err) {
        report.phaseA.errors++;
        logger.warn(
          { err, userId: grant.userId, gmailId: row.gmailMessageId },
          "Backfill phase A: rematch failed",
        );
      }
      // No-op for still-unmatched; the skip row stays and phase C may
      // pick it up if shouldFetchFullForIntel applies.
      void stillUnmatched;
    }
    if (report.phaseA.scanned % 1000 === 0) {
      logger.info({ userId: grant.userId, phaseA: report.phaseA }, "Backfill phase A progress");
    }
  }
}

/**
 * Promote a single skip-table row to a matched email_messages row.
 * Mirrors the matched branch of processOneMessage in gmailSync.ts
 * (fetch full, match, insert message + attachments, run intel).
 * Returns true on success.
 */
async function promoteSkipToMatched(
  grant: ActiveGoogleGrant,
  gmailId: string,
  summaryOnly: boolean,
): Promise<boolean> {
  let full: GmailMessage;
  try {
    full = await getMessage(grant.accessToken, gmailId, "full");
  } catch (err) {
    logger.warn(
      { err, userId: grant.userId, gmailId },
      "Backfill phase A: full fetch failed",
    );
    return false;
  }
  const fromFull = parseAddressHeader(getHeader(full.payload, "From"));
  const toFull = parseAddressHeader(getHeader(full.payload, "To"));
  const ccFull = parseAddressHeader(getHeader(full.payload, "Cc"));
  const bccFull = parseAddressHeader(getHeader(full.payload, "Bcc"));
  const subject = getHeader(full.payload, "Subject") ?? null;
  const parts = extractMessageParts(full.payload);
  const allAddrs = [...fromFull, ...toFull, ...ccFull, ...bccFull];
  const match = await matchEmails(allAddrs, grant.googleEmail);
  if (isMatchEmpty(match)) {
    // Edge case: header parse mismatch made it match in phase A's
    // shallow check but not after re-fetch. Leave skip row alone.
    return false;
  }
  const ownerLower = grant.googleEmail.toLowerCase();
  const direction: "sent" | "received" = fromFull.includes(ownerLower)
    ? "sent"
    : "received";
  const internalMs = full.internalDate ? Number(full.internalDate) : Date.now();
  const sentAt = new Date(internalMs);

  // Privacy split mirrors gmailSync.processOneMessage: in summary_only
  // mode we summarize the body in flight and persist NOTHING else —
  // no snippet, no body, no attachments, no intel.
  const aiSummary = summaryOnly
    ? await summarizeEmail({
        subject,
        fromEmail: fromFull[0] ?? null,
        bodyText: parts.bodyText,
        bodyHtml: parts.bodyHtml,
      })
    : null;
  const inserted = await db
    .insert(emailMessages)
    .values({
      id: newId(),
      gmailMessageId: gmailId,
      gmailThreadId: full.threadId,
      mailboxUserId: grant.userId,
      direction,
      sentAt,
      subject,
      snippet: summaryOnly ? null : (full.snippet ?? null),
      bodyText: summaryOnly ? null : parts.bodyText,
      bodyHtml: summaryOnly ? null : parts.bodyHtml,
      aiSummary,
      fromEmail: fromFull[0] ?? null,
      toEmails: toFull,
      ccEmails: ccFull,
      bccEmails: bccFull,
      hasAttachments: !summaryOnly && parts.attachments.length > 0,
      attachmentsComplete: summaryOnly || parts.attachments.length === 0,
      matchedPersonIds: match.personIds,
      matchedFunderIds: match.funderIds,
      matchedHouseholdIds: match.householdIds,
    })
    .onConflictDoNothing({
      target: [emailMessages.mailboxUserId, emailMessages.gmailMessageId],
    })
    .returning({ id: emailMessages.id });

  let messageRowId: string;
  if (inserted[0]) {
    messageRowId = inserted[0].id;
  } else {
    // Already in email_messages — odd but possible if a prior backfill
    // promoted it and the skip-row delete didn't land. Look up the
    // existing id so we can still clean up the skip row + top up
    // attachments below.
    const existing = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.mailboxUserId, grant.userId),
          eq(emailMessages.gmailMessageId, gmailId),
        ),
      )
      .then((r) => r[0]);
    if (!existing) return false;
    messageRowId = existing.id;
  }

  // Intel (matched path). Only on a true new insert so we don't
  // re-emit proposals on repeat backfill runs against the same row;
  // phase B will sweep already-matched rows separately. Skipped
  // entirely in summary_only mode.
  if (inserted[0] && !summaryOnly) {
    await processIntelForMatched({
      mailboxUserId: grant.userId,
      messageRowId,
      fromEmail: fromFull[0] ?? null,
      subject,
      bodyText: parts.bodyText,
      bodyHtml: parts.bodyHtml,
      direction,
      matchedPersonIds: match.personIds,
      ownerEmail: grant.googleEmail,
    });
  }

  // Attachment loop — same shape as gmailSync, idempotent on the
  // partial unique index. Skipped entirely in summary_only mode;
  // attachmentsComplete was already set true on the message row above
  // and the skip-row cleanup below proceeds as if zero attachments
  // had been requested.
  let attachmentErrors = 0;
  const attachmentList = summaryOnly ? [] : parts.attachments;
  for (const att of attachmentList) {
    try {
      const bytes = await getAttachmentBytes(
        grant.accessToken,
        gmailId,
        att.attachmentId,
      );
      const storageKey = await uploadAttachment({
        userId: grant.userId,
        gmailMessageId: gmailId,
        gmailAttachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
        bytes,
      });
      await db
        .insert(emailAttachments)
        .values({
          id: newId(),
          emailMessageId: messageRowId,
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: bytes.length,
          gmailAttachmentId: att.attachmentId,
          storageKey,
        })
        .onConflictDoNothing({
          target: [
            emailAttachments.emailMessageId,
            emailAttachments.gmailAttachmentId,
          ],
          where: sql`${emailAttachments.gmailAttachmentId} IS NOT NULL`,
        });
    } catch (err) {
      attachmentErrors++;
      logger.warn(
        { err, userId: grant.userId, gmailId, attachmentId: att.attachmentId },
        "Backfill phase A: attachment store failed",
      );
    }
  }
  if (attachmentList.length > 0 && attachmentErrors === 0) {
    await db
      .update(emailMessages)
      .set({ attachmentsComplete: true, updatedAt: new Date() })
      .where(eq(emailMessages.id, messageRowId));
  }

  // Delete the skip row only when promotion is fully complete (message
  // row committed AND all attachments persisted). If any attachment
  // failed we leave the skip row in place — a subsequent backfill run
  // will see attachments_complete=false (via the existing-id lookup
  // above), retry just the failed attachments, and only then delete
  // the skip. Without this, a transient blob-store error would
  // permanently strand the attachments since incremental sync doesn't
  // revisit historical Gmail IDs once the history cursor has passed.
  if (attachmentErrors === 0) {
    await db
      .delete(emailSyncSkip)
      .where(
        and(
          eq(emailSyncSkip.mailboxUserId, grant.userId),
          eq(emailSyncSkip.gmailMessageId, gmailId),
        ),
      );
  } else {
    logger.warn(
      { userId: grant.userId, gmailId, attachmentErrors },
      "Backfill phase A: skip row retained — attachment errors, will retry on next backfill",
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Phase B: re-intel matched messages using stored bodies (no Gmail call)
// ---------------------------------------------------------------------------

async function phaseB(
  userId: string,
  ownerEmail: string,
  report: BackfillReport,
): Promise<void> {
  let cursor: string | null = null;
  while (true) {
    const rows: Array<{
      id: string;
      fromEmail: string | null;
      subject: string | null;
      bodyText: string | null;
      bodyHtml: string | null;
      direction: "sent" | "received";
      matchedPersonIds: string[] | null;
    }> = await db
      .select({
        id: emailMessages.id,
        fromEmail: emailMessages.fromEmail,
        subject: emailMessages.subject,
        bodyText: emailMessages.bodyText,
        bodyHtml: emailMessages.bodyHtml,
        direction: emailMessages.direction,
        matchedPersonIds: emailMessages.matchedPersonIds,
      })
      .from(emailMessages)
      .where(
        cursor
          ? and(
              eq(emailMessages.mailboxUserId, userId),
              sql`${emailMessages.id} > ${cursor}`,
            )
          : eq(emailMessages.mailboxUserId, userId),
      )
      .orderBy(asc(emailMessages.id))
      .limit(PAGE);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      report.phaseB.scanned++;
      // Skip rows with no body — nothing for detectors to chew on.
      if (!row.bodyText && !row.bodyHtml) continue;
      try {
        await processIntelForMatched({
          mailboxUserId: userId,
          messageRowId: row.id,
          fromEmail: row.fromEmail,
          subject: row.subject,
          bodyText: row.bodyText,
          bodyHtml: row.bodyHtml,
          direction: row.direction,
          matchedPersonIds: row.matchedPersonIds,
          ownerEmail,
        });
        report.phaseB.ranIntel++;
      } catch (err) {
        report.phaseB.errors++;
        logger.warn(
          { err, userId, messageRowId: row.id },
          "Backfill phase B: intel failed",
        );
      }
    }
    if (report.phaseB.scanned % 2000 === 0) {
      logger.info({ userId, phaseB: report.phaseB }, "Backfill phase B progress");
    }
  }
}

// ---------------------------------------------------------------------------
// Phase C: re-intel skip rows whose sender/subject passes the full-fetch gate
// ---------------------------------------------------------------------------

async function phaseC(
  grant: ActiveGoogleGrant,
  report: BackfillReport,
): Promise<void> {
  let cursor: string | null = null;
  while (true) {
    const rows: Array<{
      gmailMessageId: string;
      fromAddrs: string[];
      subject: string | null;
    }> = await db
      .select({
        gmailMessageId: emailSyncSkip.gmailMessageId,
        fromAddrs: emailSyncSkip.fromAddrs,
        subject: emailSyncSkip.subject,
      })
      .from(emailSyncSkip)
      .where(
        cursor
          ? and(
              eq(emailSyncSkip.mailboxUserId, grant.userId),
              sql`${emailSyncSkip.gmailMessageId} > ${cursor}`,
            )
          : eq(emailSyncSkip.mailboxUserId, grant.userId),
      )
      .orderBy(asc(emailSyncSkip.gmailMessageId))
      .limit(PAGE);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].gmailMessageId;

    for (const row of rows) {
      report.phaseC.scanned++;
      const fromFirst = row.fromAddrs[0] ?? null;
      if (!shouldFetchFullForIntel(fromFirst, row.subject)) continue;
      try {
        const full = await getMessage(
          grant.accessToken,
          row.gmailMessageId,
          "full",
        );
        const parts = extractMessageParts(full.payload);
        await processIntelForUnmatched({
          mailboxUserId: grant.userId,
          gmailMessageId: row.gmailMessageId,
          fromEmail: fromFirst,
          subject: row.subject,
          bodyText: parts.bodyText,
          bodyHtml: parts.bodyHtml,
        });
        report.phaseC.ranIntel++;
      } catch (err) {
        report.phaseC.errors++;
        logger.warn(
          { err, userId: grant.userId, gmailId: row.gmailMessageId },
          "Backfill phase C: full-fetch + intel failed",
        );
      }
    }
    if (report.phaseC.scanned % 2000 === 0) {
      logger.info({ userId: grant.userId, phaseC: report.phaseC }, "Backfill phase C progress");
    }
  }
}

// ---------------------------------------------------------------------------
// Phase D: AI action proposal for any pending proposals that haven't been
// analyzed yet. Picks up rows emitted before the AI step shipped, as well
// as rows whose fire-and-forget AI call failed mid-sync. Runs strictly
// sequentially so concurrent runs don't blow through token budget; ~1–2s
// per proposal is fine because this only happens once per row over the
// life of the mailbox.
// ---------------------------------------------------------------------------

async function phaseD(userId: string, report: BackfillReport): Promise<void> {
  const PHASE_D_PAGE = 50;
  // Two-pass cursor: pass 1 picks up rows that have never been
  // analyzed (`actions_analyzed_at IS NULL`). Pass 2 retries rows
  // that errored on their last analysis attempt and haven't been
  // retried in the past 24h — that bounds how often we re-spend
  // tokens on a chronically-failing row (e.g. a payload that the
  // model rejects) while still recovering from transient errors.
  const retryAfter = new Date(Date.now() - 24 * 60 * 60 * 1000);
  for (const phase of ["fresh", "retry"] as const) {
    const seenIds = new Set<string>();
    while (true) {
      const rows = await db
        .select({ id: emailProposals.id })
        .from(emailProposals)
        .where(
          and(
            eq(emailProposals.mailboxUserId, userId),
            eq(emailProposals.status, "pending"),
            phase === "fresh"
              ? sql`${emailProposals.actionsAnalyzedAt} is null`
              : sql`${emailProposals.actionsError} is not null and ${emailProposals.actionsAnalyzedAt} < ${retryAfter}`,
          ),
        )
        .limit(PHASE_D_PAGE);
      const fresh = rows.filter((r) => !seenIds.has(r.id));
      if (fresh.length === 0) break;
      for (const row of fresh) {
        seenIds.add(row.id);
        report.phaseD.scanned++;
        try {
          // For retry pass we need to clear actions_analyzed_at so
          // the atomic claim inside proposeActionsForProposal can
          // take the row again.
          if (phase === "retry") {
            await db
              .update(emailProposals)
              .set({ actionsAnalyzedAt: null, updatedAt: new Date() })
              .where(eq(emailProposals.id, row.id));
          }
          const r = await proposeActionsForProposal(row.id);
          if (r.error) report.phaseD.errors++;
          else report.phaseD.analyzed++;
        } catch (err) {
          report.phaseD.errors++;
          logger.warn(
            { err, userId, proposalId: row.id, phase },
            "Backfill phase D: proposeActionsForProposal threw",
          );
        }
      }
      logger.info({ userId, phase, phaseD: report.phaseD }, "Backfill phase D progress");
    }
  }
}
