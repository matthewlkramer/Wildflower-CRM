import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  cleanupQueue,
  donorPaymentIntermediaries,
  giftsAndPayments,
  households,
  opportunitiesAndPledges,
  organizations,
  paymentIntermediaries,
  people,
  sourceLinks,
  stagedPayments,
  users,
  type CleanupProposal,
} from "@workspace/db/schema";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  FlagForResearchBody,
  ListCleanupQueueQueryParams,
  UpdateCleanupItemBody,
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
import { requireAdmin } from "../lib/archive";
import { recordAudit } from "../lib/audit";
import {
  donorKey,
  loadDonorNode,
  resolveDonorRouting,
  type DonorRef,
  type SqlExecutor,
} from "../lib/donorRouting";

const router: IRouter = Router();
router.use(requireAuth);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const userNameSql = (
  column:
    | typeof cleanupQueue.flaggedByUserId
    | typeof cleanupQueue.resolvedByUserId,
) => sql<string | null>`(
  SELECT COALESCE(
    NULLIF(u.display_name, ''),
    NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
    u.email
  )
  FROM users u
  WHERE u.id = ${column}
  LIMIT 1
)`;

const CLEANUP_TARGET_ID = sql.raw(`"cleanup_queue"."target_id"`);
const CLEANUP_TARGET_TYPE = sql.raw(`"cleanup_queue"."target_type"`);

const targetNameSql = sql<string | null>`COALESCE(
  (
    SELECT oap.name
    FROM opportunities_and_pledges oap
    WHERE oap.id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} IN ('pledge', 'opportunity')
  ),
  (
    SELECT sp.payer_name
    FROM staged_payments sp
    WHERE sp.id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} = 'staged_payment'
  ),
  (
    SELECT sp.payer_name
    FROM source_links sl
    JOIN staged_payments sp ON sp.id = sl.qb_staged_payment_id
    WHERE sl.link_type = 'payout_qb_settlement'
      AND sl.stripe_payout_id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} = 'stripe_payout'
    LIMIT 1
  ),
  (
    SELECT COALESCE(NULLIF(TRIM(g.name), ''), 'Gift ' || g.id)
    FROM gifts_and_payments g
    WHERE g.id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} = 'gift'
  ),
  (
    SELECT CASE WHEN p.anonymous THEN 'Anonymous' ELSE COALESCE(
      NULLIF(TRIM(p.full_name), ''),
      NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), ''),
      p.id
    ) END
    FROM people p
    WHERE p.id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} = 'person'
  ),
  (
    SELECT h.name
    FROM households h
    WHERE h.id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} = 'household'
  ),
  (
    SELECT CASE WHEN o.anonymous THEN 'Anonymous' ELSE o.name END
    FROM organizations o
    WHERE o.id = ${CLEANUP_TARGET_ID}
      AND ${CLEANUP_TARGET_TYPE} = 'organization'
  )
)`;

const cleanupSelect = {
  id: cleanupQueue.id,
  targetType: cleanupQueue.targetType,
  targetId: cleanupQueue.targetId,
  targetName: targetNameSql.as("target_name"),
  reasonCode: cleanupQueue.reasonCode,
  note: cleanupQueue.note,
  proposalKind: cleanupQueue.proposalKind,
  proposalConfidence: cleanupQueue.proposalConfidence,
  proposedChanges: cleanupQueue.proposedChanges,
  flaggedByUserId: cleanupQueue.flaggedByUserId,
  flaggedByUserName: userNameSql(cleanupQueue.flaggedByUserId).as(
    "flagged_by_user_name",
  ),
  status: cleanupQueue.status,
  flaggedAt: cleanupQueue.flaggedAt,
  resolvedAt: cleanupQueue.resolvedAt,
  resolvedByUserId: cleanupQueue.resolvedByUserId,
  resolvedByUserName: userNameSql(cleanupQueue.resolvedByUserId).as(
    "resolved_by_user_name",
  ),
  createdAt: cleanupQueue.createdAt,
  updatedAt: cleanupQueue.updatedAt,
};

type CleanupSelected = Awaited<ReturnType<typeof loadCleanupItem>>;

function serialize(row: NonNullable<CleanupSelected>) {
  return {
    ...row,
    proposalKind: row.proposalKind ?? null,
    proposalConfidence: row.proposalConfidence ?? null,
    proposedChanges: row.proposedChanges ?? null,
    flaggedByUserId: row.flaggedByUserId ?? null,
    flaggedByUserName: row.flaggedByUserName ?? null,
    flaggedAt: row.flaggedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedByUserName: row.resolvedByUserName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadCleanupItem(id: string) {
  return db
    .select(cleanupSelect)
    .from(cleanupQueue)
    .where(eq(cleanupQueue.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

class ProposalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function donorRef(value: unknown): DonorRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { kind?: unknown; id?: unknown };
  if (
    (candidate.kind === "individual" ||
      candidate.kind === "household" ||
      candidate.kind === "organization") &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  ) {
    return { kind: candidate.kind, id: candidate.id };
  }
  return null;
}

function donorColumns(ref: DonorRef) {
  return {
    organizationId: ref.kind === "organization" ? ref.id : null,
    individualGiverPersonId: ref.kind === "individual" ? ref.id : null,
    householdId: ref.kind === "household" ? ref.id : null,
  };
}

function giftDonor(gift: {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
}): DonorRef | null {
  if (gift.organizationId)
    return { kind: "organization", id: gift.organizationId };
  if (gift.individualGiverPersonId)
    return { kind: "individual", id: gift.individualGiverPersonId };
  if (gift.householdId) return { kind: "household", id: gift.householdId };
  return null;
}

function donorWhere(ref: DonorRef) {
  return ref.kind === "organization"
    ? eq(donorPaymentIntermediaries.organizationId, ref.id)
    : ref.kind === "individual"
      ? eq(donorPaymentIntermediaries.individualGiverPersonId, ref.id)
      : eq(donorPaymentIntermediaries.householdId, ref.id);
}

async function applyDefaultIntermediary(
  tx: Tx,
  donor: DonorRef,
  paymentIntermediaryId: string,
) {
  const node = await loadDonorNode(tx as unknown as SqlExecutor, donor);
  if (!node || node.archived)
    throw new ProposalError(
      409,
      "proposal_target_unavailable",
      "The donor is missing or archived.",
    );
  const [pi] = await tx
    .select({
      id: paymentIntermediaries.id,
      archivedAt: paymentIntermediaries.archivedAt,
    })
    .from(paymentIntermediaries)
    .where(eq(paymentIntermediaries.id, paymentIntermediaryId))
    .limit(1);
  if (!pi || pi.archivedAt)
    throw new ProposalError(
      409,
      "proposal_target_unavailable",
      "The payment intermediary is missing or archived.",
    );

  await tx
    .update(donorPaymentIntermediaries)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(donorWhere(donor), eq(donorPaymentIntermediaries.isDefault, true)),
    );
  const [existing] = await tx
    .select({ id: donorPaymentIntermediaries.id })
    .from(donorPaymentIntermediaries)
    .where(
      and(
        donorWhere(donor),
        eq(
          donorPaymentIntermediaries.paymentIntermediaryId,
          paymentIntermediaryId,
        ),
      ),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(donorPaymentIntermediaries)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(donorPaymentIntermediaries.id, existing.id));
  } else {
    await tx.insert(donorPaymentIntermediaries).values({
      id: newId(),
      ...donorColumns(donor),
      paymentIntermediaryId,
      isDefault: true,
    });
  }
}

async function applyProposal(id: string, req: Request) {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(cleanupQueue)
      .where(eq(cleanupQueue.id, id))
      .for("update")
      .limit(1);
    if (!item)
      throw new ProposalError(404, "not_found", "Cleanup item not found.");
    if (item.status !== "open")
      throw new ProposalError(
        409,
        "proposal_not_open",
        "This proposal is no longer open.",
      );
    const proposal = item.proposedChanges as CleanupProposal | null;
    if (!item.proposalKind || !proposal)
      throw new ProposalError(
        409,
        "proposal_missing",
        "This cleanup item has no applicable proposal.",
      );

    if (item.proposalKind === "gift_donor") {
      const to = donorRef(proposal.toDonor);
      const expectedFrom = donorRef(proposal.fromDonor);
      if (!to)
        throw new ProposalError(
          409,
          "proposal_invalid",
          "The proposed donor is invalid.",
        );
      const [gift] = await tx
        .select({
          id: giftsAndPayments.id,
          organizationId: giftsAndPayments.organizationId,
          individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
          householdId: giftsAndPayments.householdId,
          paymentIntermediaryId: giftsAndPayments.paymentIntermediaryId,
        })
        .from(giftsAndPayments)
        .where(eq(giftsAndPayments.id, item.targetId))
        .for("update")
        .limit(1);
      if (!gift)
        throw new ProposalError(
          404,
          "gift_not_found",
          "The gift no longer exists.",
        );
      const before = giftDonor(gift);
      if (!before)
        throw new ProposalError(
          409,
          "proposal_stale",
          "The gift no longer has one donor of record.",
        );
      if (expectedFrom && donorKey(expectedFrom) !== donorKey(before))
        throw new ProposalError(
          409,
          "proposal_stale",
          "The gift donor changed after this proposal was created.",
        );

      const resolution = await resolveDonorRouting(
        to,
        tx as unknown as SqlExecutor,
      );
      if (resolution.requiresDecision || !resolution.resolved)
        throw new ProposalError(
          409,
          "proposal_requires_decision",
          "The proposed pathway now requires a donor decision.",
        );
      const resolved: DonorRef = {
        kind: resolution.resolved.kind,
        id: resolution.resolved.id,
      };
      await tx
        .update(giftsAndPayments)
        .set({ ...donorColumns(resolved), updatedAt: new Date() })
        .where(eq(giftsAndPayments.id, gift.id));
      await recordAudit(tx, req, {
        action: "update",
        entityType: "gift",
        entityId: gift.id,
        summary: "Applied historical donor-attribution proposal",
        changes: [
          {
            field: "organizationId",
            from: gift.organizationId,
            to: donorColumns(resolved).organizationId,
          },
          {
            field: "individualGiverPersonId",
            from: gift.individualGiverPersonId,
            to: donorColumns(resolved).individualGiverPersonId,
          },
          {
            field: "householdId",
            from: gift.householdId,
            to: donorColumns(resolved).householdId,
          },
        ],
        metadata: {
          cleanupItemId: item.id,
          proposal,
          paymentIntermediaryIdPreserved: gift.paymentIntermediaryId,
          accountingEvidenceChanged: false,
        },
      });
    } else if (item.proposalKind === "default_intermediary") {
      const donor = donorRef(proposal.donor);
      const intermediary = proposal.paymentIntermediary;
      if (!donor || !intermediary?.id)
        throw new ProposalError(
          409,
          "proposal_invalid",
          "The proposed default intermediary is invalid.",
        );
      await applyDefaultIntermediary(tx, donor, intermediary.id);
      await recordAudit(tx, req, {
        action: "update",
        entityType: donor.kind === "individual" ? "person" : donor.kind,
        entityId: donor.id,
        summary: "Applied default payment-intermediary proposal",
        metadata: { cleanupItemId: item.id, proposal },
      });
    } else {
      throw new ProposalError(
        409,
        "proposal_invalid",
        "Unsupported proposal type.",
      );
    }

    await tx
      .update(cleanupQueue)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        resolvedByUserId: getAppUser(req)?.id ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cleanupQueue.id, item.id));
  });
  return loadCleanupItem(id);
}

function respondProposalError(
  res: Parameters<typeof notFound>[0],
  error: unknown,
) {
  if (error instanceof ProposalError) {
    res
      .status(error.status)
      .json({ error: error.code, message: error.message });
    return true;
  }
  return false;
}

router.get(
  "/cleanup-queue",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(
      ListCleanupQueueQueryParams,
      req.query,
      res,
    );
    if (!params) return;
    const { limit, page, offset } = parsePagination(params);
    const filters: SQL[] = [eq(cleanupQueue.status, params.status ?? "open")];
    if (params.proposalKind)
      filters.push(eq(cleanupQueue.proposalKind, params.proposalKind));
    if (params.reasonCode)
      filters.push(eq(cleanupQueue.reasonCode, params.reasonCode));
    const where = and(...filters)!;
    const [rows, totalRows] = await Promise.all([
      db
        .select(cleanupSelect)
        .from(cleanupQueue)
        .where(where)
        .orderBy(desc(cleanupQueue.flaggedAt))
        .limit(limit)
        .offset(offset),
      db.select({ c: count() }).from(cleanupQueue).where(where),
    ]);
    res.json({
      data: rows.map((row) => serialize(row)),
      pagination: { page, limit, total: Number(totalRows[0]?.c ?? 0) },
    });
  }),
);

router.post(
  "/cleanup-queue",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(FlagForResearchBody, req.body, res);
    if (!body) return;
    const reasonCode = "needs_research";
    const note = body.note.trim();
    if (!note) {
      res
        .status(400)
        .json({ error: "bad_request", message: "A note is required." });
      return;
    }
    const inserted = await db
      .insert(cleanupQueue)
      .values({
        id: `cleanup_nr_${body.targetId}`,
        targetType: body.targetType,
        targetId: body.targetId,
        reasonCode,
        note,
        flaggedByUserId: getAppUser(req)?.id ?? null,
        status: "open",
      })
      .onConflictDoNothing({
        target: [
          cleanupQueue.targetType,
          cleanupQueue.targetId,
          cleanupQueue.reasonCode,
        ],
      })
      .returning({ id: cleanupQueue.id });
    const id =
      inserted[0]?.id ??
      (
        await db
          .select({ id: cleanupQueue.id })
          .from(cleanupQueue)
          .where(
            and(
              eq(cleanupQueue.targetType, body.targetType),
              eq(cleanupQueue.targetId, body.targetId),
              eq(cleanupQueue.reasonCode, reasonCode),
            ),
          )
          .limit(1)
      )[0]?.id;
    if (!id) {
      res
        .status(409)
        .json({ error: "conflict", message: "Could not flag this record." });
      return;
    }
    const row = await loadCleanupItem(id);
    res.status(inserted[0] ? 201 : 200).json(row ? serialize(row) : null);
  }),
);

// Static path is intentionally declared before /:id handlers.
router.post(
  "/cleanup-queue/apply-high-confidence",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const ids = await db
      .select({ id: cleanupQueue.id })
      .from(cleanupQueue)
      .where(
        and(
          eq(cleanupQueue.status, "open"),
          eq(cleanupQueue.proposalConfidence, "high"),
        ),
      )
      .then((rows) => rows.map((row) => row.id));
    const items = [];
    let skipped = 0;
    for (const id of ids) {
      try {
        const row = await applyProposal(id, req);
        if (row) items.push(serialize(row));
      } catch {
        skipped += 1;
      }
    }
    res.json({ applied: items.length, skipped, items });
  }),
);

router.post(
  "/cleanup-queue/:id/apply-proposal",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const row = await applyProposal(paramId(req), req);
      if (!row) return notFound(res, "cleanup item");
      res.json(serialize(row));
    } catch (error) {
      if (!respondProposalError(res, error)) throw error;
    }
  }),
);

router.patch(
  "/cleanup-queue/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(UpdateCleanupItemBody, req.body, res);
    if (!body) return;
    const note = body.note.trim();
    if (!note) {
      res
        .status(400)
        .json({ error: "bad_request", message: "A cleanup note is required." });
      return;
    }
    const updated = await db
      .update(cleanupQueue)
      .set({ note, updatedAt: new Date() })
      .where(eq(cleanupQueue.id, id))
      .returning({ id: cleanupQueue.id });
    if (!updated[0]) return notFound(res, "cleanup item");
    const row = await loadCleanupItem(id);
    res.json(row ? serialize(row) : null);
  }),
);

async function transition(
  id: string,
  to: "resolved" | "dismissed",
  userId: string | null,
) {
  const updated = await db
    .update(cleanupQueue)
    .set({
      status: to,
      resolvedAt: new Date(),
      resolvedByUserId: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(cleanupQueue.id, id), eq(cleanupQueue.status, "open")))
    .returning({ id: cleanupQueue.id });
  if (updated[0]) return { row: await loadCleanupItem(id), conflict: false };
  const exists = await db
    .select({ id: cleanupQueue.id })
    .from(cleanupQueue)
    .where(eq(cleanupQueue.id, id))
    .limit(1);
  return { row: null, conflict: exists.length > 0 };
}

function makeTransitionHandler(to: "resolved" | "dismissed") {
  return asyncHandler(async (req, res) => {
    const id = paramId(req);
    const { row, conflict } = await transition(
      id,
      to,
      getAppUser(req)?.id ?? null,
    );
    if (row) {
      res.json(serialize(row));
      return;
    }
    if (conflict) {
      res
        .status(409)
        .json({ error: "conflict", message: "This item is no longer open." });
      return;
    }
    notFound(res, "cleanup item");
  });
}

router.post("/cleanup-queue/:id/resolve", makeTransitionHandler("resolved"));
router.post("/cleanup-queue/:id/dismiss", makeTransitionHandler("dismissed"));

export default router;
