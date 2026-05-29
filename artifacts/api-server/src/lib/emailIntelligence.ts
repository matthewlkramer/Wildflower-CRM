import { db } from "@workspace/db";
import {
  emailProposals,
  people,
  funders,
  peopleEntityRoles,
  emails,
  giftsAndPayments,
  type NewEmailProposal,
} from "@workspace/db/schema";
import { and, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import { proposeActionsForProposal } from "./proposeActions";
import {
  domainOf,
  extractGrantOpportunities,
  extractLinkedInJobChanges,
  isAutoResponder,
  isBounceSender,
  isFreeMailDomain,
  isLikelyGrantDigest,
  isLinkedInNotificationSender,
  parseAutoResponderMove,
  parseBounce,
  parseEmailSignature,
} from "./intelDetectors";

/**
 * Orchestrates the per-message email-intelligence pass. Pure detectors
 * live in `intelDetectors.ts`; this module wires them to the DB:
 * resolves CRM entities by fuzzy name match, filters out proposals
 * that don't actually represent a change vs current CRM state, and
 * writes them to `email_proposals` with an upsert on
 * (mailbox_user_id, dedupe_key).
 *
 * Two entry points, mirroring the two paths in `gmailSync.processOneMessage`:
 *   - processIntelForUnmatched: LinkedIn job-change digests and
 *     bounce messages (the sender isn't a CRM contact so the
 *     gmailSync match path doesn't fetch the body — this hook does).
 *   - processIntelForMatched: auto-responder-move and signature-drift
 *     signals that come from a CRM contact's reply.
 *
 * Both paths swallow their own errors — intel is best-effort and a
 * detector crash must not break the surrounding sync loop.
 */

export function shouldFetchFullForIntel(
  fromEmail: string | null | undefined,
  subject?: string | null,
): boolean {
  if (!fromEmail) return false;
  if (isLinkedInNotificationSender(fromEmail)) return true;
  if (isBounceSender(fromEmail)) return true;
  // Grant digests need the full body to extract individual
  // opportunities — header-only gate so we don't pay full-fetch on
  // every newsletter, only ones whose sender/subject look granty.
  if (isLikelyGrantDigest(fromEmail, subject ?? null)) return true;
  return false;
}

export async function processIntelForUnmatched(args: {
  mailboxUserId: string;
  gmailMessageId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  emailSentAt: Date | null;
}): Promise<void> {
  try {
    if (isLinkedInNotificationSender(args.fromEmail)) {
      await handleLinkedIn(args);
      return;
    }
    if (isBounceSender(args.fromEmail)) {
      await handleBounce(args);
      return;
    }
    if (isLikelyGrantDigest(args.fromEmail, args.subject)) {
      await handleGrants(args);
      return;
    }
  } catch (err) {
    logger.warn(
      { err, mailboxUserId: args.mailboxUserId, gmailMessageId: args.gmailMessageId },
      "Email intelligence (unmatched) failed",
    );
  }
}

export async function processIntelForMatched(args: {
  mailboxUserId: string;
  messageRowId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  direction: "sent" | "received";
  matchedPersonIds: string[] | null;
  ownerEmail: string | null;
  emailSentAt: Date | null;
}): Promise<void> {
  // We only mine inbound replies — signature / auto-responder data
  // only makes sense when the message is FROM the CRM contact, not
  // TO them.
  if (args.direction !== "received") return;
  // Internal teammate-to-teammate mail is not a CRM signal. Skip the
  // entire intel pass when the sender shares the mailbox owner's
  // domain — these messages are the dominant source of two prior
  // bugs: (a) the owner's own signature leaking out of a quoted
  // reply and being attributed to a colleague, and (b) grant /
  // RFP language in internal threads spawning runaway
  // grant_opportunity proposals against teammates' email addresses.
  const ownerDomain = domainOf(args.ownerEmail);
  const fromDomain = domainOf(args.fromEmail);
  if (ownerDomain && fromDomain && ownerDomain === fromDomain) return;
  try {
    // Grant digests can come from real CRM funders too (e.g. the
    // Foundation we already track also blasts an RFP newsletter).
    // Run grant detection on matched-path mail as well so we don't
    // miss them just because the sender is in the CRM.
    if (isLikelyGrantDigest(args.fromEmail, args.subject)) {
      await handleGrants({
        mailboxUserId: args.mailboxUserId,
        gmailMessageId: args.messageRowId,
        fromEmail: args.fromEmail,
        subject: args.subject,
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        emailSentAt: args.emailSentAt,
      });
      // Don't return — a grant digest from a CRM contact still
      // might have an auto-responder or signature payload worth
      // capturing.
    }
    if (isAutoResponder(args.subject, args.bodyText)) {
      await handleAutoResponder(args);
      return;
    }
    // Signature parsing must be attributed to the SENDER, not just
    // any participant on the thread. `matchedPersonIds` aggregates
    // every CRM person on from/to/cc/bcc (sorted by id, so index 0
    // is arbitrary) — using it directly would write a signature
    // proposal against an unrelated recipient. Resolve the sender's
    // address to a single person id; skip when ambiguous (0 or >1
    // matches) since we have no way to pick correctly.
    if (args.fromEmail) {
      const senderRows = await db
        .select({ personId: emails.personId })
        .from(emails)
        .where(
          and(
            eq(sql`lower(${emails.email})`, args.fromEmail.toLowerCase()),
            sql`${emails.personId} is not null`,
          ),
        );
      const senderPersonIds = [
        ...new Set(senderRows.map((r) => r.personId).filter((id): id is string => !!id)),
      ];
      if (senderPersonIds.length === 1) {
        await handleSignature(args, senderPersonIds[0]);
      }
    }
  } catch (err) {
    logger.warn(
      { err, mailboxUserId: args.mailboxUserId, messageRowId: args.messageRowId },
      "Email intelligence (matched) failed",
    );
  }
}

// ──────────────────────────────────────────────────────────────────
// Per-kind handlers
// ──────────────────────────────────────────────────────────────────

async function handleLinkedIn(args: {
  mailboxUserId: string;
  gmailMessageId: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  emailSentAt: Date | null;
}): Promise<void> {
  const items = extractLinkedInJobChanges(args.bodyText, args.bodyHtml, args.subject);
  if (items.length === 0) return;

  for (const it of items) {
    const personId = await findPersonByName(it.personName);
    // Only surface LinkedIn job changes for people already on file in
    // the CRM. The reviewer doesn't want to triage job-change signals
    // for strangers — an unmatched (or ambiguously-matched) name is
    // noise, not a prospect signal. Skip anything we can't pin to
    // exactly one existing person.
    const resolvedPersonId = personId && personId !== "ambiguous" ? personId : null;
    if (!resolvedPersonId) continue;

    // Skip if the person's current primary funder already matches the
    // detected new company — no signal to surface.
    const alreadyCurrent = await isPersonAlreadyAtCompany(resolvedPersonId, it.newCompany);
    if (alreadyCurrent) continue;

    await upsertProposal({
      mailboxUserId: args.mailboxUserId,
      kind: "linkedin_job_change",
      dedupeKey: `linkedin_jc:${it.personName.toLowerCase()}:${it.newCompany.toLowerCase()}`,
      targetPersonId: resolvedPersonId,
      subjectName: it.personName,
      subjectDomain: null,
      subjectEmail: null,
      emailSentAt: args.emailSentAt,
      payload: {
        personName: it.personName,
        newTitle: it.newTitle,
        newCompany: it.newCompany,
        sourceLine: it.sourceLine,
        matchConfidence: "matched",
        gmailMessageId: args.gmailMessageId,
      },
    });
  }
}

async function handleBounce(args: {
  mailboxUserId: string;
  gmailMessageId: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  emailSentAt: Date | null;
}): Promise<void> {
  const parsed = parseBounce(args.subject, args.bodyText, args.bodyHtml);
  if (!parsed) return;

  // Only act on bounces for addresses that exist in our `emails` table
  // — bouncing on a random one-off recipient isn't actionable.
  const email = await db
    .select({ id: emails.id })
    .from(emails)
    .where(ilike(emails.email, parsed.recipient))
    .limit(1)
    .then((r) => r[0]);
  if (!email) return;

  const kind = parsed.isHard ? "bounce_invalid" : "bounce_soft";
  // Hard bounces dedupe per address (one pending proposal per bad
  // email until acted on). Soft bounces dedupe per address per
  // month so repeated transient failures accumulate as distinct
  // signals worth investigating.
  const month = new Date().toISOString().slice(0, 7);
  const dedupeKey = parsed.isHard
    ? `bounce_invalid:${parsed.recipient}`
    : `bounce_soft:${parsed.recipient}:${month}`;

  await upsertProposal({
    mailboxUserId: args.mailboxUserId,
    kind,
    dedupeKey,
    targetEmailId: email.id,
    subjectEmail: parsed.recipient,
    subjectDomain: domainOf(parsed.recipient),
    subjectName: null,
    emailSentAt: args.emailSentAt,
    payload: {
      recipient: parsed.recipient,
      smtpCode: parsed.smtpCode,
      enhancedCode: parsed.enhancedCode,
      reason: parsed.reason,
      gmailMessageId: args.gmailMessageId,
    },
  });
}

async function handleGrants(args: {
  mailboxUserId: string;
  gmailMessageId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  emailSentAt: Date | null;
}): Promise<void> {
  const items = extractGrantOpportunities(
    args.subject,
    args.bodyText,
    args.bodyHtml,
    args.fromEmail,
    args.emailSentAt,
  );
  if (items.length === 0) return;

  for (const it of items) {
    // Dedupe by (funder + deadline + title-prefix). Same RFP showing
    // up in multiple newsletters or successive weekly digests will
    // collide on this key and only land once in the pending queue.
    // Title is normalized to lowercase + first 60 chars to absorb
    // small wording drift between digest sources.
    //
    // When funder AND deadline both fail to parse, the key would
    // otherwise be `grant:?:?:<title>` for every such item and
    // unrelated opportunities sharing a generic title prefix (e.g.
    // "Request for proposals") would silently collide. Mix in the
    // URL host+path (or a snippet hash) as a discriminator to keep
    // distinct opportunities distinct.
    // Dedupe strategy: when the opportunity has a URL, the URL's
    // host+path is the most stable cross-message identifier (titles
    // and funder names drift between weekly newsletter copies and
    // between digest sources, but the application link almost never
    // does). Otherwise fall back to funderName+deadline+title, with
    // a snippet hash for the low-confidence case where none of those
    // parse out and a generic title would otherwise collide unrelated
    // opportunities.
    let dedupeKey: string;
    if (it.url) {
      let urlKey = it.url.toLowerCase().slice(0, 120);
      try {
        const u = new URL(it.url);
        // Drop tracking query params — the same RFP can show up with
        // different utm_* / mc_eid / safelinks wrappers and we want
        // those to collide on one proposal.
        urlKey = `${u.host}${u.pathname}`.toLowerCase().slice(0, 120);
      } catch {
        // Bad URL — fall back to the raw string we already have.
      }
      dedupeKey = `grant:url:${urlKey}`;
    } else {
      const titleKey = it.title.toLowerCase().replace(/\s+/g, " ").slice(0, 60);
      const lowConfidence = !it.funderName && !it.deadline;
      let discriminator = "";
      if (lowConfidence) {
        // Snippet hash — stable across digest reruns, distinct
        // across unrelated opportunities. Cheap FNV-1a.
        let h = 2166136261;
        const src = it.snippet.toLowerCase();
        for (let i = 0; i < src.length; i++) {
          h ^= src.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        discriminator = `s${(h >>> 0).toString(36)}`;
      }
      dedupeKey = [
        "grant",
        it.funderName?.toLowerCase() ?? "?",
        it.deadline ?? "?",
        titleKey,
        discriminator,
      ].join(":");
    }

    // Try to attach to a CRM funder if the parsed funder name matches
    // one we already know. Soft match — accept either direction of
    // substring so "Acme Family Foundation" matches "The Acme
    // Foundation" in the CRM. Returns the first hit (rare to have
    // two funders with overlapping names; if so, reviewer can
    // disambiguate on accept).
    let targetFunderId: string | null = null;
    if (it.funderName) {
      const hit = await db
        .select({ id: funders.id })
        .from(funders)
        .where(ilike(funders.name, `%${it.funderName}%`))
        .limit(1)
        .then((r) => r[0]);
      if (hit) targetFunderId = hit.id;
    }

    await upsertProposal({
      mailboxUserId: args.mailboxUserId,
      kind: "grant_opportunity",
      dedupeKey,
      targetFunderId,
      subjectName: it.funderName,
      subjectDomain: domainOf(args.fromEmail),
      subjectEmail: args.fromEmail?.toLowerCase() ?? null,
      emailSentAt: args.emailSentAt,
      payload: {
        title: it.title,
        funderName: it.funderName,
        deadline: it.deadline,
        amount: it.amount,
        url: it.url,
        snippet: it.snippet,
        sourceDigest: args.fromEmail,
        gmailMessageId: args.gmailMessageId,
      },
    });
  }
}

async function handleAutoResponder(args: {
  mailboxUserId: string;
  messageRowId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  emailSentAt: Date | null;
}): Promise<void> {
  if (!args.fromEmail) return;
  const move = parseAutoResponderMove(args.bodyText, args.bodyHtml);
  if (!move) return;

  // Resolve which person this sender is — gmailSync already matched
  // them, but we need the id; cheap lookup via the emails table.
  const emailRow = await db
    .select({ personId: emails.personId })
    .from(emails)
    .where(ilike(emails.email, args.fromEmail))
    .limit(1)
    .then((r) => r[0]);
  const personId = emailRow?.personId ?? null;

  const dedupeSig = [
    move.newCompany?.toLowerCase() ?? "",
    move.newEmail?.toLowerCase() ?? "",
    move.leftCompany?.toLowerCase() ?? "",
  ].filter(Boolean).join("|");
  if (!dedupeSig) return;

  await upsertProposal({
    mailboxUserId: args.mailboxUserId,
    kind: "auto_responder_move",
    dedupeKey: `auto_move:${args.fromEmail.toLowerCase()}:${dedupeSig}`,
    sourceMessageId: args.messageRowId,
    targetPersonId: personId,
    subjectEmail: args.fromEmail.toLowerCase(),
    subjectName: null,
    subjectDomain: domainOf(args.fromEmail),
    emailSentAt: args.emailSentAt,
    payload: { ...move, fromEmail: args.fromEmail },
  });
}

async function handleSignature(
  args: {
    mailboxUserId: string;
    messageRowId: string;
    fromEmail: string | null;
    bodyText: string | null;
    bodyHtml: string | null;
    ownerEmail: string | null;
    emailSentAt: Date | null;
  },
  personId: string,
): Promise<void> {
  const sig = parseEmailSignature(args.bodyText, args.bodyHtml);
  if (!sig) return;
  // Need either title or company changes vs current state for this
  // to be worth surfacing.
  if (!sig.title && !sig.company && !sig.phone) return;
  // Last-resort guard against the parser still latching onto a
  // quoted-reply block: if the email we pulled out of the sig isn't
  // the sender's address (and isn't blank), the sig almost certainly
  // belongs to someone else in the thread (most often the mailbox
  // owner). Drop it rather than attribute the wrong job to the
  // matched CRM person.
  const ownerDomain = domainOf(args.ownerEmail);
  const sigDomain = domainOf(sig.email);
  const fromDomain = domainOf(args.fromEmail);
  if (sig.email && args.ownerEmail && sig.email === args.ownerEmail.toLowerCase()) return;
  if (sigDomain && ownerDomain && sigDomain === ownerDomain) return;
  if (sig.email && fromDomain && sigDomain && sigDomain !== fromDomain) return;

  const person = await db
    .select({
      id: people.id,
      fullName: people.fullName,
    })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1)
    .then((r) => r[0]);
  if (!person) return;

  // Name-attribution guard: if the signature carries its OWN name and
  // that name clearly isn't the CRM person we resolved the sender to,
  // the parser almost certainly grabbed a signature belonging to
  // someone else in the thread (a forwarded/quoted participant). Drop
  // it rather than copy a stranger's title/phone onto our person.
  if (sig.name && person.fullName && !namesPlausiblyMatch(sig.name, person.fullName)) {
    return;
  }

  // Compare detected company against any current peopleEntityRoles
  // funder for this person. If the sig company already matches, we
  // don't have a "drift" to surface.
  let companyDrift = false;
  if (sig.company) {
    const currentFunderNames = await db
      .select({ name: funders.name })
      .from(peopleEntityRoles)
      .innerJoin(funders, eq(funders.id, peopleEntityRoles.funderId))
      .where(
        and(
          eq(peopleEntityRoles.personId, personId),
          eq(peopleEntityRoles.current, "current"),
        ),
      );
    const sigLower = sig.company.toLowerCase();
    const matched = currentFunderNames.some(
      (f) =>
        f.name &&
        (f.name.toLowerCase().includes(sigLower) || sigLower.includes(f.name.toLowerCase())),
    );
    if (!matched) companyDrift = true;
  }

  // If only phone/title (no company drift) we still want to surface
  // because phone numbers / titles are often new info too — but we
  // gate on "something non-empty was parsed". The accept handler
  // decides which fields to actually copy across.
  await upsertProposal({
    mailboxUserId: args.mailboxUserId,
    kind: "signature_update",
    dedupeKey: `sig:${args.fromEmail?.toLowerCase() ?? personId}`,
    sourceMessageId: args.messageRowId,
    targetPersonId: personId,
    subjectEmail: args.fromEmail?.toLowerCase() ?? null,
    subjectName: person.fullName ?? sig.name,
    subjectDomain: domainOf(args.fromEmail),
    emailSentAt: args.emailSentAt,
    payload: {
      parsed: sig,
      companyDrift,
      fromEmail: args.fromEmail,
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// DB helpers
// ──────────────────────────────────────────────────────────────────

async function upsertProposal(args: {
  mailboxUserId: string;
  kind: NewEmailProposal["kind"];
  dedupeKey: string;
  sourceMessageId?: string | null;
  targetPersonId?: string | null;
  targetFunderId?: string | null;
  targetEmailId?: string | null;
  subjectEmail?: string | null;
  subjectName?: string | null;
  subjectDomain?: string | null;
  emailSentAt?: Date | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  const id = newId();
  const inserted = await db
    .insert(emailProposals)
    .values({
      id,
      mailboxUserId: args.mailboxUserId,
      kind: args.kind,
      dedupeKey: args.dedupeKey,
      sourceMessageId: args.sourceMessageId ?? null,
      targetPersonId: args.targetPersonId ?? null,
      targetFunderId: args.targetFunderId ?? null,
      targetEmailId: args.targetEmailId ?? null,
      subjectEmail: args.subjectEmail ?? null,
      subjectName: args.subjectName ?? null,
      subjectDomain: args.subjectDomain ?? null,
      emailSentAt: args.emailSentAt ?? null,
      payload: args.payload,
    })
    .onConflictDoNothing({
      // The unique index on (mailbox_user_id, dedupe_key) is partial —
      // it only covers rows with status = 'pending' so that a future
      // identical signal can re-surface after a prior proposal is
      // resolved (applied/rejected/ignored). Postgres requires the
      // ON CONFLICT clause to mirror the index predicate or it raises
      // "no unique or exclusion constraint matching the ON CONFLICT
      // specification". The `where` here maps to that index_predicate.
      target: [emailProposals.mailboxUserId, emailProposals.dedupeKey],
      where: sql`status = 'pending'`,
    })
    .returning({ id: emailProposals.id });

  // Fire-and-forget AI action proposal. Only kicks off when we
  // actually inserted (returning is empty on conflict-do-nothing) so
  // a re-emit of the same signal doesn't re-spend tokens. Errors are
  // swallowed inside proposeActionsForProposal — they only land in
  // the row's `actionsError` column, never in the sync loop.
  // Operational escape hatch: bulk reprocessing jobs set
  // SKIP_INLINE_ACTION_PROPOSAL=1 so detection doesn't fan out
  // hundreds of unthrottled concurrent AI calls. Those jobs run a
  // sequential phase-D sweep afterwards instead. Defaults to the
  // normal inline behavior when unset.
  if (inserted.length > 0 && process.env.SKIP_INLINE_ACTION_PROPOSAL !== "1") {
    const newProposalId = inserted[0].id;
    void proposeActionsForProposal(newProposalId).catch((err) => {
      logger.warn({ err, proposalId: newProposalId }, "proposeActionsForProposal threw");
    });
  }
}

// Returns:
//   - personId string when exactly one CRM person matches the name
//   - "ambiguous" when 2+ match (don't auto-attach)
//   - null when nobody matches
async function findPersonByName(
  name: string,
): Promise<string | "ambiguous" | null> {
  const trimmed = name.trim();
  if (trimmed.length < 3) return null;
  const rows = await db
    .select({ id: people.id })
    .from(people)
    .where(ilike(people.fullName, trimmed))
    .limit(3);
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].id;
  return "ambiguous";
}

// Loose name comparison for the signature attribution guard. Two
// names "plausibly match" when they share their first AND last token
// (case-insensitive, punctuation-stripped), so "Beth Smith" still
// matches "Beth A. Smith" but "Daniel Glass" does NOT match
// "Elizabeth Badillo Moorman". Deliberately permissive — we only use
// this to REJECT obvious cross-person mismatches, not to confirm
// matches, so a false "match" just lets the existing domain guards do
// their job.
const NAME_SUFFIXES = new Set([
  "jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "esq", "mba", "rn", "do",
]);

function namesPlausiblyMatch(a: string, b: string): boolean {
  const toks = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1)
      .filter((t) => !NAME_SUFFIXES.has(t));
  const at = toks(a);
  const bt = toks(b);
  if (at.length === 0 || bt.length === 0) return true; // can't judge
  const aFirst = at[0];
  const aLast = at[at.length - 1];
  const bFirst = bt[0];
  const bLast = bt[bt.length - 1];
  const lastMatch = aLast === bLast;
  const firstMatch =
    aFirst === bFirst ||
    aFirst.startsWith(bFirst) ||
    bFirst.startsWith(aFirst); // nickname/initial tolerance
  return lastMatch && firstMatch;
}

async function isPersonAlreadyAtCompany(
  personId: string,
  companyName: string,
): Promise<boolean> {
  if (!companyName) return false;
  const rows = await db
    .select({ name: funders.name })
    .from(peopleEntityRoles)
    .innerJoin(funders, eq(funders.id, peopleEntityRoles.funderId))
    .where(
      and(
        eq(peopleEntityRoles.personId, personId),
        eq(peopleEntityRoles.current, "current"),
      ),
    );
  const target = companyName.toLowerCase();
  return rows.some(
    (r) =>
      r.name &&
      (r.name.toLowerCase().includes(target) || target.includes(r.name.toLowerCase())),
  );
}

// Re-export free-mail check so the unrecognized-correspondent route
// can share the same definition.
export { isFreeMailDomain };

// ──────────────────────────────────────────────────────────────────
// Thank-you acknowledgment detector (outbound path)
// ──────────────────────────────────────────────────────────────────

/**
 * Document mime types worth treating as "the grant receipt / thank-you
 * letter the funder actually wants on file". Filters out inline
 * images, calendar invites, etc. Kept intentionally permissive — the
 * reviewer can always reject a false positive in the inbox.
 */
function isDocumentMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  if (m === "application/pdf") return true;
  if (m === "application/rtf" || m === "text/rtf") return true;
  if (m === "application/msword") return true;
  if (m === "application/vnd.ms-excel") return true;
  if (m === "application/vnd.ms-powerpoint") return true;
  if (m.startsWith("application/vnd.openxmlformats-officedocument")) return true;
  if (m.startsWith("application/vnd.oasis.opendocument")) return true;
  return false;
}

export function hasThankInSubject(subject: string | null | undefined): boolean {
  return !!subject && /\bthank/i.test(subject);
}

export function countDocumentAttachments(
  parts: { mimeType?: string | null; filename?: string | null }[],
): number {
  return parts.filter((p) => isDocumentMime(p.mimeType)).length;
}

/**
 * Outbound-path intel hook. Mirrors processIntelForMatched but runs
 * on direction='sent' messages only (the matched-path function ignores
 * outbound entirely so signature / auto-responder parsing isn't
 * misapplied to staff). Today the only signal is the thank-you
 * acknowledgment heuristic; future outbound signals can land here.
 *
 * Best-effort — failures are warned and swallowed so a detector bug
 * never propagates back into the gmail sync loop.
 */
export async function processIntelForOutbound(args: {
  mailboxUserId: string;
  messageRowId: string;
  fromEmail: string | null;
  toEmails: string[] | null;
  subject: string | null;
  sentAt: Date;
  attachmentMimeTypes: string[];
}): Promise<void> {
  try {
    await detectThankYou(args);
  } catch (err) {
    logger.warn(
      { err, mailboxUserId: args.mailboxUserId, messageRowId: args.messageRowId },
      "Email intelligence (outbound) failed",
    );
  }
}

async function detectThankYou(args: {
  mailboxUserId: string;
  messageRowId: string;
  fromEmail: string | null;
  toEmails: string[] | null;
  subject: string | null;
  sentAt: Date;
  attachmentMimeTypes: string[];
}): Promise<void> {
  if (!hasThankInSubject(args.subject)) return;
  const docCount = args.attachmentMimeTypes.filter(isDocumentMime).length;
  if (docCount < 1) return;
  const recipients = (args.toEmails ?? [])
    .map((r) => r?.toLowerCase().trim())
    .filter((r): r is string => !!r);
  if (recipients.length === 0) return;

  // Resolve every recipient to a funder id, either directly (funder-
  // level email row) or via people_entity_roles where current='current'.
  // Returns the de-duped union.
  const funderRows = await db.execute<{ funder_id: string }>(sql`
    SELECT DISTINCT funder_id FROM (
      SELECT e.funder_id
      FROM emails e
      WHERE lower(e.email) = ANY(${recipients}::text[])
        AND e.funder_id IS NOT NULL
      UNION
      SELECT per.funder_id
      FROM emails e
      JOIN people_entity_roles per ON per.person_id = e.person_id
      WHERE lower(e.email) = ANY(${recipients}::text[])
        AND e.person_id IS NOT NULL
        AND per.current = 'current'
        AND per.funder_id IS NOT NULL
    ) t
  `);
  const funderIds = funderRows.rows.map((r) => r.funder_id).filter(Boolean);
  if (funderIds.length === 0) return;

  // Find candidate gifts to those funders within ±30 days of the
  // outbound email. Most often there is one and we link it directly;
  // when several match we emit one proposal per gift and let the
  // reviewer pick the right one — payload.giftId is the suggestion,
  // not the only option.
  const windowStart = new Date(args.sentAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(args.sentAt.getTime() + 1 * 24 * 60 * 60 * 1000);
  const startDate = windowStart.toISOString().slice(0, 10);
  const endDate = windowEnd.toISOString().slice(0, 10);
  const candidateGifts = await db
    .select({
      id: giftsAndPayments.id,
      funderId: giftsAndPayments.funderId,
      amount: giftsAndPayments.amount,
      dateReceived: giftsAndPayments.dateReceived,
      thankYouEmailMessageId: giftsAndPayments.thankYouEmailMessageId,
    })
    .from(giftsAndPayments)
    .where(
      and(
        sql`${giftsAndPayments.funderId} = ANY(${funderIds}::text[])`,
        gte(giftsAndPayments.dateReceived, startDate),
        lte(giftsAndPayments.dateReceived, endDate),
      ),
    );
  // Skip gifts that already have a thank-you linked — re-proposing the
  // same gift after acceptance would just create review noise.
  const unlinked = candidateGifts.filter((g) => !g.thankYouEmailMessageId);
  if (unlinked.length === 0) return;

  for (const gift of unlinked) {
    await upsertProposal({
      mailboxUserId: args.mailboxUserId,
      kind: "thank_you_acknowledgment",
      // One pending proposal per (gift, message). If the user rejects
      // it we want a re-sync of the same email NOT to re-emit; the
      // partial unique index (status='pending') already enforces that.
      dedupeKey: `thankyou:${gift.id}:${args.messageRowId}`,
      sourceMessageId: args.messageRowId,
      targetFunderId: gift.funderId,
      subjectEmail: recipients[0] ?? null,
      subjectDomain: domainOf(recipients[0] ?? null),
      subjectName: null,
      emailSentAt: args.sentAt,
      payload: {
        giftId: gift.id,
        funderId: gift.funderId,
        giftAmount: gift.amount,
        giftDateReceived: gift.dateReceived,
        fromEmail: args.fromEmail,
        toEmails: args.toEmails,
        subject: args.subject,
        sentAt: args.sentAt.toISOString(),
        documentAttachmentCount: docCount,
      },
    });
  }
}
