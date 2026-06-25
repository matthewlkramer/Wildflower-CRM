import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  emailIntelPrompts,
  emailProposals,
  users,
  type EmailIntelPrompt,
} from "@workspace/db/schema";
import { and, count, desc, eq, ilike, inArray, isNull, notExists, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { anthropic, withRateLimitRetry } from "@workspace/integrations-anthropic-ai";
import {
  AdminGenerateEmailIntelPromptBody,
  AdminListEmailIntelFeedbackQueryParams,
  AdminSaveEmailIntelPromptBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { type ProposedAction } from "../lib/proposeActions";
import {
  EMAIL_INTEL_REVIEW_PHASES,
  EMAIL_INTEL_SIGNAL_TYPES,
  buildDefaultReviewPrompt,
  kindsForSignalType,
  signalTypeLabel,
  type EmailIntelReviewPhase,
  type EmailIntelSignalType,
} from "../lib/emailIntelPrompts";
import { aiProposalLimit } from "../lib/aiConcurrency";
import { logger } from "../lib/logger";

/**
 * Email-intelligence admin console.
 *
 * Lets an admin hand-edit / AI-draft / version / revert the per-(signal type,
 * review phase) REVIEW prompts that shape the email-intelligence pipeline, and
 * browse a cross-mailbox feed of reviewer feedback (accepted / rejected
 * proposals + reviewer notes + the actions the AI proposed) to inform those
 * edits.
 *
 * IMPORTANT: the hidden, hard-coded action-proposing CORE prompt ("how to
 * act") is NEVER exposed by any route here — admins can neither see nor edit
 * it. Only the accuracy + suppression review criteria are editable.
 *
 * Versioning model (see `emailIntelPrompts` schema), scoped PER KEY
 * (signalType, reviewPhase):
 *   - exactly one `active` row per key at a time (the pipeline reads it),
 *   - at most one `draft` row per key (an AI-generated candidate),
 *   - all superseded versions kept as `archived` history.
 * Saving / activating / reverting never destroys a prior version — a revert
 * copies an old version's text into a brand-new active row for that key.
 *
 * Every route is admin-only (403 otherwise) so the frontend can hide the whole
 * console behind the same 403-gate it uses for other admin sections.
 */

const router: IRouter = Router();
router.use(requireAuth);

const MODEL = "claude-sonnet-4-6";

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): import("@workspace/db/schema").User | null {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return null;
  }
  return me;
}

function fullName(
  u: { displayName: string | null; firstName: string | null; lastName: string | null } | null,
): string | null {
  if (!u) return null;
  if (u.displayName?.trim()) return u.displayName.trim();
  const joined = [u.firstName, u.lastName].filter((p) => p?.trim()).join(" ").trim();
  return joined || null;
}

/**
 * Serialize a prompt row for the API, resolving the author's display
 * name from a pre-fetched lookup map so we don't N+1 the users table.
 */
function serializePrompt(
  row: EmailIntelPrompt,
  authorNames: Map<string, string | null>,
) {
  return {
    id: row.id,
    promptText: row.promptText,
    status: row.status,
    origin: row.origin,
    signalType: row.signalType,
    reviewPhase: row.reviewPhase,
    authorUserId: row.authorUserId,
    authorName: row.authorUserId ? authorNames.get(row.authorUserId) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadAuthorNames(
  rows: EmailIntelPrompt[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((r) => r.authorUserId).filter((v): v is string => !!v))];
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const authors = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const a of authors) map.set(a.id, fullName(a));
  return map;
}

// ── Prompt console ──────────────────────────────────────────────────

/**
 * Console: the full state of every review-prompt key (one per signal type ×
 * review phase). For each key we return the live active version (omitted while
 * on the built-in default), any outstanding AI draft, the archived history
 * (newest first), the built-in default text, and whether the pipeline is
 * currently on the default. The hidden action-proposing core is never
 * returned.
 */
router.get(
  "/admin/email-intel/prompts",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await db
      .select()
      .from(emailIntelPrompts)
      .orderBy(desc(emailIntelPrompts.createdAt));
    const authorNames = await loadAuthorNames(rows);

    const keys = EMAIL_INTEL_SIGNAL_TYPES.flatMap((signalType) =>
      EMAIL_INTEL_REVIEW_PHASES.map((reviewPhase) => {
        const forKey = rows.filter(
          (r) => r.signalType === signalType && r.reviewPhase === reviewPhase,
        );
        const active = forKey.find((r) => r.status === "active") ?? null;
        const draft = forKey.find((r) => r.status === "draft") ?? null;
        const history = forKey.filter((r) => r.status === "archived");
        return {
          signalType,
          reviewPhase,
          active: active ? serializePrompt(active, authorNames) : null,
          draft: draft ? serializePrompt(draft, authorNames) : null,
          history: history.map((r) => serializePrompt(r, authorNames)),
          default: buildDefaultReviewPrompt(signalType, reviewPhase),
          usingDefault: !active,
        };
      }),
    );
    res.json({ keys });
  }),
);

/**
 * Save a hand-edited review prompt as the new active version FOR ONE KEY.
 * Demotes that key's current active row to `archived` (preserving history)
 * and inserts a new `active` row in the same transaction. Other keys are
 * untouched.
 */
router.post(
  "/admin/email-intel/prompts",
  asyncHandler(async (req, res) => {
    const me = requireAdmin(req, res);
    if (!me) return;
    const body = parseOrBadRequest(AdminSaveEmailIntelPromptBody, req.body, res);
    if (!body) return;
    const promptText = body.promptText.trim();
    if (!promptText) {
      res.status(400).json({ error: "validation_error", message: "promptText is required" });
      return;
    }
    const signalType = body.signalType as EmailIntelSignalType;
    const reviewPhase = body.reviewPhase as EmailIntelReviewPhase;
    const saved = await db.transaction(async (tx) => {
      await tx
        .update(emailIntelPrompts)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(emailIntelPrompts.status, "active"),
            eq(emailIntelPrompts.signalType, signalType),
            eq(emailIntelPrompts.reviewPhase, reviewPhase),
          ),
        );
      const [row] = await tx
        .insert(emailIntelPrompts)
        .values({
          id: newId(),
          promptText,
          status: "active",
          origin: "hand_edited",
          signalType,
          reviewPhase,
          authorUserId: me.id,
        })
        .returning();
      return row;
    });
    const authorNames = await loadAuthorNames([saved]);
    res.json(serializePrompt(saved, authorNames));
  }),
);

/**
 * Generate an improved review-prompt draft FOR ONE KEY from recent reviewer
 * feedback scoped to that signal type. Saves the result as a non-active
 * `draft` (replacing any existing draft for that key) — never auto-applied.
 * The admin reviews + approves it via the activate route.
 */
router.post(
  "/admin/email-intel/prompts/generate",
  asyncHandler(async (req, res) => {
    const me = requireAdmin(req, res);
    if (!me) return;
    const body = parseOrBadRequest(AdminGenerateEmailIntelPromptBody, req.body, res);
    if (!body) return;
    const signalType = body.signalType as EmailIntelSignalType;
    const reviewPhase = body.reviewPhase as EmailIntelReviewPhase;

    // Current baseline: this key's active prompt, or its built-in default.
    const [activeRow] = await db
      .select()
      .from(emailIntelPrompts)
      .where(
        and(
          eq(emailIntelPrompts.status, "active"),
          eq(emailIntelPrompts.signalType, signalType),
          eq(emailIntelPrompts.reviewPhase, reviewPhase),
        ),
      )
      .limit(1);
    const currentPrompt =
      activeRow?.promptText ?? buildDefaultReviewPrompt(signalType, reviewPhase);

    // Recent resolved feedback for THIS signal type's kinds, newest first.
    const feedback = await db
      .select()
      .from(emailProposals)
      .where(
        and(
          inArray(emailProposals.status, ["applied", "rejected", "ignored"]),
          inArray(emailProposals.kind, kindsForSignalType(signalType)),
        ),
      )
      .orderBy(desc(emailProposals.resolvedAt))
      .limit(120);
    if (feedback.length === 0) {
      res.status(409).json({
        error: "no_feedback",
        message: `No resolved ${signalTypeLabel(signalType)} proposals to learn from yet.`,
      });
      return;
    }

    const feedbackDigest = feedback
      .map((f) => {
        const actions = Array.isArray(f.proposedActions)
          ? (f.proposedActions as ProposedAction[])
          : [];
        const actionSummary = actions.length
          ? actions.map((a) => a.type).join(", ")
          : "(none)";
        const verdict =
          f.status === "applied" ? "ACCEPTED" : f.status === "rejected" ? "REJECTED" : "IGNORED";
        const note = f.reviewerNote?.trim() ? ` | reviewer note: "${f.reviewerNote.trim()}"` : "";
        return `- [${verdict}] kind=${f.kind} subject=${f.subjectName ?? f.subjectEmail ?? "(unknown)"} proposed_actions=[${actionSummary}]${note}`;
      })
      .join("\n");

    const phaseGoal =
      reviewPhase === "accuracy"
        ? "These ACCURACY criteria decide whether the detected signal is genuinely what it claims to be; an inaccurate verdict hides the proposal from the reviewer with a distinct 'Flagged inaccurate' reason."
        : "These SUPPRESSION criteria decide whether an ACCURATE signal is nonetheless noise not worth a reviewer's time; a suppress verdict hides the proposal with an 'Auto-suppressed' reason.";

    const userPrompt = [
      `You are tuning the ${reviewPhase.toUpperCase()} REVIEW CRITERIA for "${signalTypeLabel(signalType)}" email-intelligence proposals.`,
      phaseGoal,
      "Below is the CURRENT review-criteria text for this signal type and phase, followed by a sample of recent reviewer feedback (which proposals humans ACCEPTED, REJECTED, or IGNORED, with any notes they left).",
      "",
      "Produce an IMPROVED version of ONLY these review criteria that would better match reviewer judgment — reduce wrongly-hidden good proposals and wrongly-shown noise — while staying narrowly scoped to this one signal type and this one review phase. Do NOT write action/how-to-act instructions (those live in a separate hidden prompt). Do NOT mention other signal types. Keep it concise.",
      "",
      "Return ONLY the full revised review-criteria text, with no preamble, commentary, or code fences.",
      "",
      "===== CURRENT REVIEW CRITERIA =====",
      currentPrompt,
      "",
      "===== RECENT REVIEWER FEEDBACK =====",
      feedbackDigest,
    ].join("\n");

    const response = await aiProposalLimit(() =>
      withRateLimitRetry(
        () =>
          anthropic.messages.create(
            {
              model: MODEL,
              max_tokens: 8192,
              messages: [{ role: "user", content: userPrompt }],
            },
            { timeout: 120000, maxRetries: 0 },
          ),
        {
          onRetry: ({ attempt, delayMs }) =>
            logger.info({ attempt, delayMs }, "generateEmailIntelPrompt: rate-limited, backing off"),
        },
      ),
    );

    let generated = "";
    for (const block of response.content) {
      if (block.type === "text") generated += block.text;
    }
    generated = generated.trim();
    if (!generated) {
      res.status(502).json({
        error: "generation_failed",
        message: "The AI returned an empty prompt. Please try again.",
      });
      return;
    }

    const draft = await db.transaction(async (tx) => {
      // Replace any outstanding draft FOR THIS KEY — one candidate per key.
      await tx
        .delete(emailIntelPrompts)
        .where(
          and(
            eq(emailIntelPrompts.status, "draft"),
            eq(emailIntelPrompts.signalType, signalType),
            eq(emailIntelPrompts.reviewPhase, reviewPhase),
          ),
        );
      const [row] = await tx
        .insert(emailIntelPrompts)
        .values({
          id: newId(),
          promptText: generated,
          status: "draft",
          origin: "ai_generated",
          signalType,
          reviewPhase,
          authorUserId: me.id,
        })
        .returning();
      return row;
    });
    const authorNames = await loadAuthorNames([draft]);
    res.json(serializePrompt(draft, authorNames));
  }),
);

/**
 * Activate a version: promote the target row to `active` and demote the
 * current active row FOR THE SAME KEY to `archived`. Used to approve an AI
 * draft. The activated row's origin is preserved.
 */
router.post(
  "/admin/email-intel/prompts/:id/activate",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const [target] = await db
      .select()
      .from(emailIntelPrompts)
      .where(eq(emailIntelPrompts.id, id))
      .limit(1);
    if (!target) return notFound(res, "email-intel prompt");
    if (target.status === "active") {
      const authorNames = await loadAuthorNames([target]);
      res.json(serializePrompt(target, authorNames));
      return;
    }
    const activated = await db.transaction(async (tx) => {
      const keyFilters: SQL[] = [eq(emailIntelPrompts.status, "active")];
      keyFilters.push(
        target.signalType
          ? eq(emailIntelPrompts.signalType, target.signalType)
          : isNull(emailIntelPrompts.signalType),
      );
      keyFilters.push(
        target.reviewPhase
          ? eq(emailIntelPrompts.reviewPhase, target.reviewPhase)
          : isNull(emailIntelPrompts.reviewPhase),
      );
      await tx
        .update(emailIntelPrompts)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(...keyFilters));
      const [row] = await tx
        .update(emailIntelPrompts)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(emailIntelPrompts.id, id))
        .returning();
      return row;
    });
    const authorNames = await loadAuthorNames([activated]);
    res.json(serializePrompt(activated, authorNames));
  }),
);

/**
 * Revert to a prior version by COPYING its text into a brand-new active row
 * (origin `reverted`) for the SAME key. The old version stays in history
 * untouched — revert never destroys.
 */
router.post(
  "/admin/email-intel/prompts/:id/revert",
  asyncHandler(async (req, res) => {
    const me = requireAdmin(req, res);
    if (!me) return;
    const id = paramId(req);
    const [target] = await db
      .select()
      .from(emailIntelPrompts)
      .where(eq(emailIntelPrompts.id, id))
      .limit(1);
    if (!target) return notFound(res, "email-intel prompt");
    const reverted = await db.transaction(async (tx) => {
      const keyFilters: SQL[] = [eq(emailIntelPrompts.status, "active")];
      keyFilters.push(
        target.signalType
          ? eq(emailIntelPrompts.signalType, target.signalType)
          : isNull(emailIntelPrompts.signalType),
      );
      keyFilters.push(
        target.reviewPhase
          ? eq(emailIntelPrompts.reviewPhase, target.reviewPhase)
          : isNull(emailIntelPrompts.reviewPhase),
      );
      await tx
        .update(emailIntelPrompts)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(...keyFilters));
      const [row] = await tx
        .insert(emailIntelPrompts)
        .values({
          id: newId(),
          promptText: target.promptText,
          status: "active",
          origin: "reverted",
          signalType: target.signalType,
          reviewPhase: target.reviewPhase,
          authorUserId: me.id,
        })
        .returning();
      return row;
    });
    const authorNames = await loadAuthorNames([reverted]);
    res.json(serializePrompt(reverted, authorNames));
  }),
);

/**
 * Discard an outstanding AI draft. Only `draft` rows may be deleted —
 * active + archived versions are immutable history.
 */
router.delete(
  "/admin/email-intel/prompts/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const [target] = await db
      .select()
      .from(emailIntelPrompts)
      .where(eq(emailIntelPrompts.id, id))
      .limit(1);
    if (!target) return notFound(res, "email-intel prompt");
    if (target.status !== "draft") {
      res.status(409).json({
        error: "not_a_draft",
        message: "Only an outstanding AI draft can be discarded.",
      });
      return;
    }
    await db.delete(emailIntelPrompts).where(eq(emailIntelPrompts.id, id));
    res.json({ ok: true });
  }),
);

// ── Cross-mailbox feedback feed ─────────────────────────────────────

/**
 * Cross-mailbox feed of resolved proposal feedback for prompt tuning.
 * Unlike `/email-proposals` (scoped to the caller's mailbox), this is a
 * read-only admin view across ALL mailboxes — accepted/rejected/ignored
 * proposals with their reviewer notes, the actions the AI proposed, the
 * mailbox owner, and who resolved them.
 */
router.get(
  "/admin/email-intel/feedback",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = parseOrBadRequest(AdminListEmailIntelFeedbackQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);

    const filters: SQL[] = [
      inArray(emailProposals.status, ["applied", "rejected", "ignored"]),
    ];
    if (q.kind) filters.push(eq(emailProposals.kind, q.kind));
    if (q.status) filters.push(eq(emailProposals.status, q.status));
    // `real` hides feedback authored by the automated test accounts that e2e
    // runs auto-provision ("Test Dev" / "Test Admin"), leaving only feedback
    // from genuine human reviewers. The test-account predicate MUST stay in
    // lockstep with scripts/src/cleanup-test-users.ts. Rows with a NULL
    // resolver (e.g. legacy/system-resolved) are kept — NOT EXISTS is true
    // when there is no matching test user.
    if (q.reviewerSource === "real") {
      const testReviewer = alias(users, "test_reviewer");
      filters.push(
        notExists(
          db
            .select({ id: testReviewer.id })
            .from(testReviewer)
            .where(
              and(
                eq(testReviewer.id, emailProposals.resolvedByUserId),
                ilike(testReviewer.firstName, "Test"),
                inArray(testReviewer.lastName, ["Dev", "Admin"]),
              ),
            ),
        ),
      );
    }
    const where = and(...filters);

    const mailbox = users;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db
        .select()
        .from(emailProposals)
        .where(where)
        .orderBy(desc(emailProposals.resolvedAt), desc(emailProposals.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(emailProposals).where(where),
    ]);

    // Resolve mailbox-owner + resolver display names in one pass.
    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.mailboxUserId, r.resolvedByUserId])
          .filter((v): v is string => !!v),
      ),
    ];
    const nameMap = new Map<string, string | null>();
    if (userIds.length > 0) {
      const us = await db
        .select({
          id: mailbox.id,
          displayName: mailbox.displayName,
          firstName: mailbox.firstName,
          lastName: mailbox.lastName,
        })
        .from(mailbox)
        .where(inArray(mailbox.id, userIds));
      for (const u of us) nameMap.set(u.id, fullName(u));
    }

    const data = rows.map((r) => {
      const actions = Array.isArray(r.proposedActions)
        ? (r.proposedActions as ProposedAction[])
        : [];
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        reviewerNote: r.reviewerNote,
        mailboxUserId: r.mailboxUserId,
        mailboxUserName: nameMap.get(r.mailboxUserId) ?? null,
        resolvedByUserId: r.resolvedByUserId,
        resolverName: r.resolvedByUserId ? nameMap.get(r.resolvedByUserId) ?? null : null,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        subjectName: r.subjectName,
        subjectEmail: r.subjectEmail,
        proposedActions: actions.map((a) => ({
          type: a.type,
          reason: "reason" in a && typeof a.reason === "string" ? a.reason : "",
        })),
        createdAt: r.createdAt.toISOString(),
        emailSentAt: r.emailSentAt ? r.emailSentAt.toISOString() : null,
      };
    });

    res.json({ data, pagination: { page, limit, total: Number(total) } });
  }),
);

export default router;
