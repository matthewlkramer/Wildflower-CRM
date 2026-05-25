import { db } from "@workspace/db";
import {
  emailProposals,
  people,
  funders,
  peopleEntityRoles,
  emails,
  type NewEmailProposal,
} from "@workspace/db/schema";
import { and, eq, ilike } from "drizzle-orm";
import { logger } from "./logger";
import { newId } from "./helpers";
import {
  domainOf,
  extractLinkedInJobChanges,
  isAutoResponder,
  isBounceSender,
  isFreeMailDomain,
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

export function shouldFetchFullForIntel(fromEmail: string | null | undefined): boolean {
  if (!fromEmail) return false;
  return isLinkedInNotificationSender(fromEmail) || isBounceSender(fromEmail);
}

export async function processIntelForUnmatched(args: {
  mailboxUserId: string;
  gmailMessageId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
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
}): Promise<void> {
  // We only mine inbound replies — signature / auto-responder data
  // only makes sense when the message is FROM the CRM contact, not
  // TO them.
  if (args.direction !== "received") return;
  try {
    if (isAutoResponder(args.subject, args.bodyText)) {
      await handleAutoResponder(args);
      return;
    }
    // Signature parsing only on the first matched person — we don't
    // want to attribute the same sender's sig to multiple unrelated
    // CRM rows.
    if (args.matchedPersonIds && args.matchedPersonIds.length > 0) {
      await handleSignature(args, args.matchedPersonIds[0]);
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
}): Promise<void> {
  const items = extractLinkedInJobChanges(args.bodyText, args.bodyHtml, args.subject);
  if (items.length === 0) return;

  for (const it of items) {
    const personId = await findPersonByName(it.personName);
    // We surface even unmatched LinkedIn items so the reviewer can
    // decide to create the person — this is one of the most valuable
    // ways the panel finds new prospects. Confidence is encoded in
    // payload.matchConfidence.
    const matchConfidence: "matched" | "ambiguous" | "none" =
      personId === null ? "none" : personId === "ambiguous" ? "ambiguous" : "matched";
    const resolvedPersonId = personId && personId !== "ambiguous" ? personId : null;

    // Skip if the person's current primary funder already matches the
    // detected new company — no signal to surface.
    if (resolvedPersonId) {
      const alreadyCurrent = await isPersonAlreadyAtCompany(resolvedPersonId, it.newCompany);
      if (alreadyCurrent) continue;
    }

    await upsertProposal({
      mailboxUserId: args.mailboxUserId,
      kind: "linkedin_job_change",
      dedupeKey: `linkedin_jc:${it.personName.toLowerCase()}:${it.newCompany.toLowerCase()}`,
      targetPersonId: resolvedPersonId,
      subjectName: it.personName,
      subjectDomain: null,
      subjectEmail: null,
      payload: {
        personName: it.personName,
        newTitle: it.newTitle,
        newCompany: it.newCompany,
        sourceLine: it.sourceLine,
        matchConfidence,
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
    payload: {
      recipient: parsed.recipient,
      smtpCode: parsed.smtpCode,
      enhancedCode: parsed.enhancedCode,
      reason: parsed.reason,
      gmailMessageId: args.gmailMessageId,
    },
  });
}

async function handleAutoResponder(args: {
  mailboxUserId: string;
  messageRowId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
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
  },
  personId: string,
): Promise<void> {
  const sig = parseEmailSignature(args.bodyText, args.bodyHtml);
  if (!sig) return;
  // Need either title or company changes vs current state for this
  // to be worth surfacing.
  if (!sig.title && !sig.company && !sig.phone) return;

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
  payload: Record<string, unknown>;
}): Promise<void> {
  await db
    .insert(emailProposals)
    .values({
      id: newId(),
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
      payload: args.payload,
    })
    .onConflictDoNothing({
      target: [emailProposals.mailboxUserId, emailProposals.dedupeKey],
    });
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
