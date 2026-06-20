import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  users,
  people,
  organizations,
  opportunitiesAndPledges,
  giftsAndPayments,
  interactions,
  tasks,
  grantLeads,
} from "@workspace/db/schema";
import { count, eq } from "drizzle-orm";
import {
  GetOwnedRecordCountsQueryParams,
  ReassignOwnerBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { asyncHandler, notFound, parseOrBadRequest } from "../lib/helpers";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();
router.use(requireAuth);

// Owner-bearing tables. Every `owner_user_id` (and tasks' single-owner
// `assignee_user_id`) FK is ON DELETE RESTRICT, so a departing team member
// cannot be removed until their records are reassigned. `tasks.created_by_user_id`
// is intentionally NOT touched — it is historical provenance, not ownership.

type UserRow = typeof users.$inferSelect;

function userLabel(u: UserRow): string {
  const name =
    u.displayName?.trim() ||
    [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email;
}

interface OwnedCounts {
  people: number;
  organizations: number;
  opportunities: number;
  gifts: number;
  interactions: number;
  tasks: number;
  grantLeads: number;
  total: number;
}

/** Count rows owned by `userId` across every owner-bearing table. */
async function ownedCounts(userId: string): Promise<OwnedCounts> {
  const [p, o, opp, g, i, t, gl] = await Promise.all([
    db.select({ v: count() }).from(people).where(eq(people.ownerUserId, userId)),
    db
      .select({ v: count() })
      .from(organizations)
      .where(eq(organizations.ownerUserId, userId)),
    db
      .select({ v: count() })
      .from(opportunitiesAndPledges)
      .where(eq(opportunitiesAndPledges.ownerUserId, userId)),
    db
      .select({ v: count() })
      .from(giftsAndPayments)
      .where(eq(giftsAndPayments.ownerUserId, userId)),
    db
      .select({ v: count() })
      .from(interactions)
      .where(eq(interactions.ownerUserId, userId)),
    db.select({ v: count() }).from(tasks).where(eq(tasks.assigneeUserId, userId)),
    db
      .select({ v: count() })
      .from(grantLeads)
      .where(eq(grantLeads.assigneeUserId, userId)),
  ]);
  const counts = {
    people: Number(p[0]?.v ?? 0),
    organizations: Number(o[0]?.v ?? 0),
    opportunities: Number(opp[0]?.v ?? 0),
    gifts: Number(g[0]?.v ?? 0),
    interactions: Number(i[0]?.v ?? 0),
    tasks: Number(t[0]?.v ?? 0),
    grantLeads: Number(gl[0]?.v ?? 0),
  };
  return {
    ...counts,
    total:
      counts.people +
      counts.organizations +
      counts.opportunities +
      counts.gifts +
      counts.interactions +
      counts.tasks +
      counts.grantLeads,
  };
}

// GET /admin/owned-record-counts?userId=… — preview an offboarding reassignment.
router.get(
  "/admin/owned-record-counts",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const q = parseOrBadRequest(GetOwnedRecordCountsQueryParams, req.query, res);
    if (!q) return;
    res.json(await ownedCounts(q.userId));
  }),
);

// POST /admin/reassign-owner — move every record from one owner to another in a
// single transaction, optionally archiving the source user (offboarding).
//
// `updated_at` is deliberately NOT bumped: ownership re-pointing is an
// administrative change, and touching thousands of rows' timestamps would shove
// a departing user's whole book to the top of every "recently updated" view.
// The audit-log row is the durable record of the change.
router.post(
  "/admin/reassign-owner",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(ReassignOwnerBody, req.body, res);
    if (!body) return;
    const { fromUserId, toUserId, archiveSource } = body;

    if (fromUserId === toUserId) {
      res.status(400).json({
        error: "same_user",
        message: "Source and destination users must differ.",
      });
      return;
    }

    const [fromUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, fromUserId));
    if (!fromUser) return notFound(res, "source user");
    const [toUser] = await db.select().from(users).where(eq(users.id, toUserId));
    if (!toUser) return notFound(res, "destination user");
    if (toUser.archivedAt) {
      res.status(400).json({
        error: "destination_archived",
        message: "Cannot reassign records to an archived user.",
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const peopleRows = await tx
        .update(people)
        .set({ ownerUserId: toUserId })
        .where(eq(people.ownerUserId, fromUserId))
        .returning({ id: people.id });
      const orgRows = await tx
        .update(organizations)
        .set({ ownerUserId: toUserId })
        .where(eq(organizations.ownerUserId, fromUserId))
        .returning({ id: organizations.id });
      const oppRows = await tx
        .update(opportunitiesAndPledges)
        .set({ ownerUserId: toUserId })
        .where(eq(opportunitiesAndPledges.ownerUserId, fromUserId))
        .returning({ id: opportunitiesAndPledges.id });
      const giftRows = await tx
        .update(giftsAndPayments)
        .set({ ownerUserId: toUserId })
        .where(eq(giftsAndPayments.ownerUserId, fromUserId))
        .returning({ id: giftsAndPayments.id });
      const interactionRows = await tx
        .update(interactions)
        .set({ ownerUserId: toUserId })
        .where(eq(interactions.ownerUserId, fromUserId))
        .returning({ id: interactions.id });
      const taskRows = await tx
        .update(tasks)
        .set({ assigneeUserId: toUserId })
        .where(eq(tasks.assigneeUserId, fromUserId))
        .returning({ id: tasks.id });
      const grantLeadRows = await tx
        .update(grantLeads)
        .set({ assigneeUserId: toUserId })
        .where(eq(grantLeads.assigneeUserId, fromUserId))
        .returning({ id: grantLeads.id });

      const reassigned: OwnedCounts = {
        people: peopleRows.length,
        organizations: orgRows.length,
        opportunities: oppRows.length,
        gifts: giftRows.length,
        interactions: interactionRows.length,
        tasks: taskRows.length,
        grantLeads: grantLeadRows.length,
        total:
          peopleRows.length +
          orgRows.length +
          oppRows.length +
          giftRows.length +
          interactionRows.length +
          taskRows.length +
          grantLeadRows.length,
      };

      let archivedSource = false;
      if (archiveSource && !fromUser.archivedAt) {
        await tx
          .update(users)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, fromUserId));
        archivedSource = true;
      }

      await recordAudit(tx, req, {
        action: "bulk_update",
        entityType: "user",
        entityId: fromUserId,
        summary: `Reassigned ${reassigned.total} record(s) from ${userLabel(
          fromUser,
        )} to ${userLabel(toUser)}${
          archivedSource ? " and archived the source user" : ""
        }.`,
        metadata: { fromUserId, toUserId, reassigned, archivedSource },
      });

      return { reassigned, archivedSource };
    });

    res.json(result);
  }),
);

export default router;
