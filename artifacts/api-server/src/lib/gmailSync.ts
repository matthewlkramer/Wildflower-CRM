import { db } from "@workspace/db";
import {
  emailMessages,
  emailAttachments,
  emailSyncSkip,
  emailSyncState,
  type EmailSyncState,
} from "@workspace/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import {
  getMessage,
  getProfile,
  getAttachmentBytes,
  listHistory,
  listMessageIds,
  extractMessageParts,
  getHeader,
  parseAddressHeader,
  GmailHistoryGoneError,
  type GmailMessage,
} from "./gmail";
import { getValidGoogleAccessTokenForUser, type ActiveGoogleGrant } from "./googleTokenStore";
import { matchEmails, isMatchEmpty, type EmailMatchResult } from "./emailMatcher";
import { uploadAttachment } from "./emailAttachmentStore";

/**
 * Per-mailbox Gmail sync orchestrator.
 *
 * Two modes, gated on `state.bootstrap_completed_at`:
 *
 *   1. Bootstrap — page through `users.messages.list?q=newer_than:30d`.
 *      Capped at BOOTSTRAP_MAX_PAGES_PER_RUN per trigger so a single
 *      run can't monopolise the worker. The page token is stashed in
 *      `state.bootstrap_page_token`; when Gmail stops returning a
 *      nextPageToken we pin `last_history_id = profile.historyId` and
 *      switch to incremental on the next run.
 *
 *   2. Incremental — page through `users.history.list?startHistoryId=
 *      last_history_id`. Also capped at HISTORY_MAX_PAGES_PER_RUN. The
 *      pending page token lives in `state.incremental_page_token` and
 *      we only advance `last_history_id` AFTER the full set of history
 *      pages has been drained — otherwise a partial pass that hit the
 *      cap would skip the un-consumed deltas permanently. On
 *      `GmailHistoryGoneError` (Gmail GC'd the historyId) we drop the
 *      cursor and re-bootstrap on the next run.
 *
 * Per-message pipeline (`processOneMessage`):
 *   a. Fast skip if (mailbox, gmail_id) already in `email_messages`
 *      or `email_sync_skip`.
 *   b. Fetch metadata-only (From/To/Cc/Bcc/Subject/Date).
 *   c. Match participants against the `emails` table (matcher drops
 *      the mailbox owner + @wildflowerschools.org).
 *   d. If matched: fetch full message, persist body + headers (ON
 *      CONFLICT DO NOTHING on the (mailbox, gmail_id) unique index),
 *      download + store attachments (each insert ON CONFLICT DO
 *      NOTHING on (email_message_id, gmail_attachment_id) — the
 *      unique partial index). Counters only increment for true
 *      inserts.
 *   e. If unmatched: insert into `email_sync_skip` ON CONFLICT DO
 *      NOTHING.
 *
 * Failure semantics: per-message transient failures (network blip,
 * 5xx from Gmail, GCS write error) return `false` from
 * `processOneMessage` and bump `report.errors`. When any page has a
 * non-zero error count, that page's pagination cursor is NOT
 * advanced — the next run re-fetches the same page and
 * `filterUnseenIds` ensures already-stored messages aren't
 * re-processed, so only the failures get retried. This is the
 * simplest correct retry policy that loses nothing.
 */

// Empty query = bootstrap the entire mailbox (Gmail excludes Spam and
// Trash by default, which is what we want — we don't ingest those into
// the CRM). Per-source page caps + the in-process scheduler ensure
// this drains in the background without blowing Google quota even on
// large mailboxes.
const BOOTSTRAP_QUERY = "";
const BOOTSTRAP_PAGE_SIZE = 100;
const BOOTSTRAP_MAX_PAGES_PER_RUN = 3;
const HISTORY_MAX_PAGES_PER_RUN = 10;

export interface GmailSyncReport {
  mode: "bootstrap" | "incremental" | "rebootstrap";
  candidates: number;
  matched: number;
  skipped: number;
  errors: number;
  attachments: number;
  attachmentBytes: number;
  bootstrapCompleted: boolean;
  finalHistoryId: string | null;
}

export interface GmailSyncOutcome {
  ok: boolean;
  notConnected?: boolean;
  error?: string;
  report?: GmailSyncReport;
}

export async function syncUserGmail(userId: string): Promise<GmailSyncOutcome> {
  const grant = await getValidGoogleAccessTokenForUser(userId);
  if (!grant) {
    return { ok: false, notConnected: true };
  }

  // Race-safe state row provisioning: ON CONFLICT DO NOTHING tolerates
  // a concurrent trigger that beat us to the insert, then we read back
  // unconditionally. Two parallel "Resync now" clicks won't crash.
  await db
    .insert(emailSyncState)
    .values({ mailboxUserId: userId })
    .onConflictDoNothing();
  const state = await db
    .select()
    .from(emailSyncState)
    .where(eq(emailSyncState.mailboxUserId, userId))
    .then((r) => r[0]);
  if (!state) {
    return { ok: false, error: "Failed to provision sync state row" };
  }

  try {
    const report: GmailSyncReport = {
      mode: state.bootstrapCompletedAt ? "incremental" : "bootstrap",
      candidates: 0,
      matched: 0,
      skipped: 0,
      errors: 0,
      attachments: 0,
      attachmentBytes: 0,
      bootstrapCompleted: !!state.bootstrapCompletedAt,
      finalHistoryId: state.lastHistoryId ?? null,
    };

    if (!state.bootstrapCompletedAt) {
      await runBootstrapPass(grant, state, report);
    } else if (state.lastHistoryId) {
      try {
        await runIncrementalPass(grant, state, report);
      } catch (e) {
        if (e instanceof GmailHistoryGoneError) {
          report.mode = "rebootstrap";
          await db
            .update(emailSyncState)
            .set({
              lastHistoryId: null,
              bootstrapCompletedAt: null,
              bootstrapPageToken: null,
              incrementalPageToken: null,
              lastError: "Gmail history expired; re-bootstrapping on next run",
              lastSyncedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(emailSyncState.mailboxUserId, userId));
          return { ok: true, report };
        }
        throw e;
      }
    } else {
      // bootstrap_completed but no last_history_id: shouldn't happen,
      // but treat as needing a re-bootstrap rather than silently
      // re-fetching all of history.
      report.mode = "rebootstrap";
      await db
        .update(emailSyncState)
        .set({
          bootstrapCompletedAt: null,
          bootstrapPageToken: null,
          incrementalPageToken: null,
          updatedAt: new Date(),
        })
        .where(eq(emailSyncState.mailboxUserId, userId));
    }

    await db
      .update(emailSyncState)
      .set({
        lastSyncedAt: new Date(),
        lastError: report.errors > 0
          ? `${report.errors} message(s) failed; will retry next run`
          : null,
        updatedAt: new Date(),
      })
      .where(eq(emailSyncState.mailboxUserId, userId));

    return { ok: true, report };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ err: e, userId }, "Gmail sync run failed");
    await db
      .update(emailSyncState)
      .set({ lastError: msg, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(emailSyncState.mailboxUserId, userId));
    return { ok: false, error: msg };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Pass implementations
// ──────────────────────────────────────────────────────────────────────────

async function runBootstrapPass(
  grant: ActiveGoogleGrant,
  state: EmailSyncState,
  report: GmailSyncReport,
): Promise<void> {
  // `pageToken` is what we'll pass to the NEXT listMessageIds call.
  // `currentPageToken` is what produced the page we just processed —
  // we stash that one on error so the next run retries this same
  // page.
  let pageToken: string | null = state.bootstrapPageToken ?? null;
  let pagesProcessed = 0;
  let drained = false;

  while (pagesProcessed < BOOTSTRAP_MAX_PAGES_PER_RUN) {
    const currentPageToken: string | null = pageToken;
    const page = await listMessageIds(grant.accessToken, {
      q: BOOTSTRAP_QUERY,
      pageToken: currentPageToken,
      maxResults: BOOTSTRAP_PAGE_SIZE,
    });
    pagesProcessed++;

    const ids = page.messages.map((m) => m.id);
    let pageErrors = 0;
    if (ids.length > 0) {
      const newIds = await filterUnseenIds(grant.userId, ids);
      report.candidates += newIds.length;
      for (const id of newIds) {
        const ok = await processOneMessage(grant, id, report);
        if (!ok) pageErrors++;
      }
    }
    report.errors += pageErrors;

    if (pageErrors > 0) {
      // Don't advance past this page — leave the cursor at the token
      // that produced it so we retry next run. `filterUnseenIds`
      // protects already-stored messages from being re-processed.
      await db
        .update(emailSyncState)
        .set({
          bootstrapPageToken: currentPageToken,
          updatedAt: new Date(),
        })
        .where(eq(emailSyncState.mailboxUserId, grant.userId));
      return;
    }

    if (!page.nextPageToken) {
      drained = true;
      break;
    }
    pageToken = page.nextPageToken;
  }

  if (drained) {
    // Bootstrap window exhausted with zero errors. Pin the mailbox
    // cursor to the current historyId so the next run goes
    // incremental.
    const profile = await getProfile(grant.accessToken);
    await db
      .update(emailSyncState)
      .set({
        bootstrapCompletedAt: new Date(),
        bootstrapPageToken: null,
        lastHistoryId: profile.historyId,
        updatedAt: new Date(),
      })
      .where(eq(emailSyncState.mailboxUserId, grant.userId));
    report.bootstrapCompleted = true;
    report.finalHistoryId = profile.historyId;
  } else {
    // Hit per-run page cap with no errors. Stash the NEXT token so the
    // next run picks up where this one left off.
    await db
      .update(emailSyncState)
      .set({
        bootstrapPageToken: pageToken,
        updatedAt: new Date(),
      })
      .where(eq(emailSyncState.mailboxUserId, grant.userId));
  }
}

async function runIncrementalPass(
  grant: ActiveGoogleGrant,
  state: EmailSyncState,
  report: GmailSyncReport,
): Promise<void> {
  const startHistoryId = state.lastHistoryId!;
  let pageToken: string | null = state.incrementalPageToken ?? null;
  let pagesProcessed = 0;
  let latestHistoryId: string | null = null;
  let drained = false;

  while (pagesProcessed < HISTORY_MAX_PAGES_PER_RUN) {
    const currentPageToken: string | null = pageToken;
    const page = await listHistory(grant.accessToken, startHistoryId, currentPageToken);
    pagesProcessed++;
    latestHistoryId = page.historyId ?? latestHistoryId;

    const addedIds: string[] = [];
    for (const h of page.history) {
      for (const a of h.messagesAdded ?? []) addedIds.push(a.message.id);
      for (const m of h.messages ?? []) addedIds.push(m.id);
    }
    const unique = [...new Set(addedIds)];
    let pageErrors = 0;
    if (unique.length > 0) {
      const newIds = await filterUnseenIds(grant.userId, unique);
      report.candidates += newIds.length;
      for (const id of newIds) {
        const ok = await processOneMessage(grant, id, report);
        if (!ok) pageErrors++;
      }
    }
    report.errors += pageErrors;

    if (pageErrors > 0) {
      // Save the failing page's token so we replay it next run.
      // Critically, do NOT advance last_history_id — Gmail will
      // still serve us this delta on the retry.
      await db
        .update(emailSyncState)
        .set({
          incrementalPageToken: currentPageToken,
          updatedAt: new Date(),
        })
        .where(eq(emailSyncState.mailboxUserId, grant.userId));
      return;
    }

    if (!page.nextPageToken) {
      drained = true;
      break;
    }
    pageToken = page.nextPageToken;
  }

  if (drained) {
    // Full drain succeeded — advance to the latest historyId AND
    // clear the page token in the same write.
    if (latestHistoryId) {
      await db
        .update(emailSyncState)
        .set({
          lastHistoryId: latestHistoryId,
          incrementalPageToken: null,
          updatedAt: new Date(),
        })
        .where(eq(emailSyncState.mailboxUserId, grant.userId));
      report.finalHistoryId = latestHistoryId;
    }
  } else {
    // Hit per-run page cap with no errors. Save the NEXT token so the
    // next run continues; keep last_history_id pinned until full
    // drain.
    await db
      .update(emailSyncState)
      .set({
        incrementalPageToken: pageToken,
        updatedAt: new Date(),
      })
      .where(eq(emailSyncState.mailboxUserId, grant.userId));
  }
}

async function filterUnseenIds(
  userId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  // NB: deliberately filter to `attachments_complete = true`. A
  // message whose body is stored but whose attachments failed to
  // upload last run still needs to be re-processed so the
  // (idempotent) attachment loop can top up the missing rows. The
  // pre-loop check inside `processOneMessage` short-circuits the
  // byte re-download once everything's actually present, so the
  // retry path is cheap.
  const [existingMsg, existingSkip] = await Promise.all([
    db
      .select({ id: emailMessages.gmailMessageId })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.mailboxUserId, userId),
          inArray(emailMessages.gmailMessageId, ids),
          eq(emailMessages.attachmentsComplete, true),
        ),
      ),
    db
      .select({ id: emailSyncSkip.gmailMessageId })
      .from(emailSyncSkip)
      .where(
        and(
          eq(emailSyncSkip.mailboxUserId, userId),
          inArray(emailSyncSkip.gmailMessageId, ids),
        ),
      ),
  ]);
  const seen = new Set([
    ...existingMsg.map((r) => r.id),
    ...existingSkip.map((r) => r.id),
  ]);
  return ids.filter((id) => !seen.has(id));
}

/**
 * Returns true if the message was fully processed (or was already
 * stored — in which case we still try to top up missing attachments
 * idempotently). Returns false on any per-message error worth
 * retrying — the pass-level loop uses this to gate cursor
 * advancement.
 */
async function processOneMessage(
  grant: ActiveGoogleGrant,
  gmailId: string,
  report: GmailSyncReport,
): Promise<boolean> {
  let meta: GmailMessage;
  try {
    meta = await getMessage(grant.accessToken, gmailId, "metadata");
  } catch (e) {
    logger.warn(
      { err: e, userId: grant.userId, gmailId },
      "Failed to fetch Gmail metadata; will retry next sync",
    );
    return false;
  }

  const fromAddrs = parseAddressHeader(getHeader(meta.payload, "From"));
  const toAddrs = parseAddressHeader(getHeader(meta.payload, "To"));
  const ccAddrs = parseAddressHeader(getHeader(meta.payload, "Cc"));
  const bccAddrs = parseAddressHeader(getHeader(meta.payload, "Bcc"));
  const allAddrs = [...fromAddrs, ...toAddrs, ...ccAddrs, ...bccAddrs];
  let match: EmailMatchResult;
  try {
    match = await matchEmails(allAddrs, grant.googleEmail);
  } catch (e) {
    logger.warn({ err: e, userId: grant.userId, gmailId }, "Matcher query failed");
    return false;
  }

  if (isMatchEmpty(match)) {
    // Persist enough metadata that, if a new CRM contact is added
    // later whose email shows up in any of from/to/cc/bcc, we can
    // surface the previously-skipped message and re-download its body
    // + attachments. This makes the skip table forward-compatible
    // without needing to keep the body bytes around.
    const subject = getHeader(meta.payload, "Subject") ?? null;
    const dateRaw = getHeader(meta.payload, "Date");
    let sentAt: Date | null = null;
    if (dateRaw) {
      const parsed = new Date(dateRaw);
      if (!Number.isNaN(parsed.getTime())) sentAt = parsed;
    }
    await db
      .insert(emailSyncSkip)
      .values({
        mailboxUserId: grant.userId,
        gmailMessageId: gmailId,
        fromAddrs: fromAddrs,
        toAddrs: toAddrs,
        ccAddrs: ccAddrs,
        bccAddrs: bccAddrs,
        subject,
        sentAt,
      })
      .onConflictDoNothing();
    report.skipped++;
    return true;
  }

  let full: GmailMessage;
  try {
    full = await getMessage(grant.accessToken, gmailId, "full");
  } catch (e) {
    logger.warn(
      { err: e, userId: grant.userId, gmailId },
      "Matched message but full fetch failed; will retry next sync",
    );
    return false;
  }
  const fromFull = parseAddressHeader(getHeader(full.payload, "From"));
  const toFull = parseAddressHeader(getHeader(full.payload, "To"));
  const ccFull = parseAddressHeader(getHeader(full.payload, "Cc"));
  const bccFull = parseAddressHeader(getHeader(full.payload, "Bcc"));
  const subject = getHeader(full.payload, "Subject") ?? null;
  const parts = extractMessageParts(full.payload);

  // Direction: "sent" iff the mailbox owner is in the From line.
  // (Self-cc — owner in both From and To — still counts as sent;
  // the From header is what Gmail itself uses to bucket the
  // message into Sent.)
  const ownerLower = grant.googleEmail.toLowerCase();
  const direction: "sent" | "received" = fromFull.includes(ownerLower)
    ? "sent"
    : "received";
  const internalMs = full.internalDate ? Number(full.internalDate) : Date.now();
  const sentAt = new Date(internalMs);

  // ON CONFLICT DO NOTHING on the (mailbox, gmail_id) unique index.
  // `returning({ id })` returns the new row's id on a real insert,
  // or an empty array if the row already existed.
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
      snippet: full.snippet ?? null,
      bodyText: parts.bodyText,
      bodyHtml: parts.bodyHtml,
      fromEmail: fromFull[0] ?? null,
      toEmails: toFull,
      ccEmails: ccFull,
      bccEmails: bccFull,
      hasAttachments: parts.attachments.length > 0,
      // Optimistic: empty attachment list means already complete;
      // non-empty starts false and is flipped true after a clean
      // attachment-loop iteration below.
      attachmentsComplete: parts.attachments.length === 0,
      matchedPersonIds: match.personIds,
      matchedFunderIds: match.funderIds,
      matchedHouseholdIds: match.householdIds,
    })
    .onConflictDoNothing({
      target: [emailMessages.mailboxUserId, emailMessages.gmailMessageId],
    })
    .returning({ id: emailMessages.id });

  let messageRowId: string;
  let wasNewMessage: boolean;
  if (inserted[0]) {
    messageRowId = inserted[0].id;
    wasNewMessage = true;
    report.matched++;
  } else {
    // Already stored (race or a prior partial run that wrote the
    // message but failed mid-attachment-loop). Look up the existing
    // row id so we can top up any missing attachments below.
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
    wasNewMessage = false;
  }

  // Attachment loop — idempotent on the (email_message_id,
  // gmail_attachment_id) unique partial index. On replay we'll
  // still re-fetch + re-upload bytes, but the DB row only inserts
  // once and counters only increment when `returning()` actually
  // returns a row.
  //
  // Optimization for fully-stored messages: if the message already
  // existed AND a row exists for every attachment we'd insert, we
  // can skip the whole loop. Cheap to check, saves the byte
  // re-download in the steady-state replay.
  if (!wasNewMessage && parts.attachments.length > 0) {
    const attIds = parts.attachments
      .map((a) => a.attachmentId)
      .filter((x): x is string => !!x);
    if (attIds.length > 0) {
      const have = await db
        .select({ aid: emailAttachments.gmailAttachmentId })
        .from(emailAttachments)
        .where(
          and(
            eq(emailAttachments.emailMessageId, messageRowId),
            inArray(emailAttachments.gmailAttachmentId, attIds),
          ),
        );
      if (have.length === attIds.length) {
        // Everything already stored — skip the re-download loop.
        // Also flip attachments_complete=true if it's still false
        // (e.g. a prior run inserted every attachment row but
        // crashed before the post-loop UPDATE). Conditional WHERE
        // avoids a needless write on the already-true steady state.
        await db
          .update(emailMessages)
          .set({ attachmentsComplete: true, updatedAt: new Date() })
          .where(
            and(
              eq(emailMessages.id, messageRowId),
              eq(emailMessages.attachmentsComplete, false),
            ),
          );
        return true;
      }
    }
  }

  let attachmentErrorsThisPass = 0;
  for (const att of parts.attachments) {
    try {
      const bytes = await getAttachmentBytes(grant.accessToken, gmailId, att.attachmentId);
      const storageKey = await uploadAttachment({
        userId: grant.userId,
        gmailMessageId: gmailId,
        gmailAttachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
        bytes,
      });
      const insertedAtt = await db
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
          target: [emailAttachments.emailMessageId, emailAttachments.gmailAttachmentId],
          // The unique index is partial (WHERE gmail_attachment_id IS
          // NOT NULL) — Postgres requires the ON CONFLICT clause to
          // repeat that predicate so the planner can match the partial
          // index. Without this, every attachment insert fails with
          // "no unique or exclusion constraint matching".
          where: sql`${emailAttachments.gmailAttachmentId} IS NOT NULL`,
        })
        .returning({ id: emailAttachments.id });
      if (insertedAtt[0]) {
        // True insert — count the bytes. If it was a no-op (replay),
        // skip counters so the report stays honest.
        report.attachments++;
        report.attachmentBytes += bytes.length;
      }
    } catch (e) {
      logger.warn(
        { err: e, userId: grant.userId, gmailId, attachmentId: att.attachmentId },
        "Failed to fetch / store attachment; will retry next sync",
      );
      // One attachment failure shouldn't poison the whole message —
      // the message row is already persisted and the next run will
      // top up the missing attachment via the loop above.
      report.errors++;
      attachmentErrorsThisPass++;
    }
  }
  // Successful attachment pass: flip attachments_complete=true so
  // future sync runs stop replaying this message. If we already had
  // it true (e.g. message inserted with zero attachments), the
  // UPDATE is a no-op. Failure pass: leave the flag false AND
  // return false so the pass-level loop holds the cursor — Gmail
  // will replay the same message id next run.
  if (parts.attachments.length > 0 && attachmentErrorsThisPass === 0) {
    await db
      .update(emailMessages)
      .set({ attachmentsComplete: true, updatedAt: new Date() })
      .where(eq(emailMessages.id, messageRowId));
  }
  return attachmentErrorsThisPass === 0;
}
