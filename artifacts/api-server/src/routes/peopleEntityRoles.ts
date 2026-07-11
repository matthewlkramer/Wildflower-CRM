import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { peopleEntityRoles } from "@workspace/db/schema";
import { and, count, desc, eq, ne, type SQL } from "drizzle-orm";
import {
  ListPeopleEntityRolesQueryParams,
  CreatePeopleEntityRoleBody,
  UpdatePeopleEntityRoleBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { peopleEntityRolesQuery, maskPeopleEntityRoles } from "../lib/peopleRolesSelect";
import { getViewer } from "../lib/identityVisibility";

const router: IRouter = Router();
router.use(requireAuth);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Keep at most one primary contact per entity: when a role is marked primary,
// demote any *other* primary role pointing at the same entity (organization,
// household, or payment intermediary) inside the same transaction.
async function demoteOtherPrimaries(
  tx: Tx,
  row: typeof peopleEntityRoles.$inferSelect,
) {
  const scope = row.organizationId
    ? eq(peopleEntityRoles.organizationId, row.organizationId)
    : row.householdId
      ? eq(peopleEntityRoles.householdId, row.householdId)
      : row.paymentIntermediaryId
        ? eq(peopleEntityRoles.paymentIntermediaryId, row.paymentIntermediaryId)
        : null;
  if (!scope) return;
  await tx
    .update(peopleEntityRoles)
    .set({ primaryContact: false, updatedAt: new Date() })
    .where(
      and(
        scope,
        eq(peopleEntityRoles.primaryContact, true),
        ne(peopleEntityRoles.id, row.id),
      ),
    );
}

router.get(
  "/people-entity-roles",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPeopleEntityRolesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.personId) filters.push(eq(peopleEntityRoles.personId, q.personId));
    
    if (q.organizationId) filters.push(eq(peopleEntityRoles.organizationId, q.organizationId));
    if (q.paymentIntermediaryId) filters.push(eq(peopleEntityRoles.paymentIntermediaryId, q.paymentIntermediaryId));
    if (q.householdId) filters.push(eq(peopleEntityRoles.householdId, q.householdId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      peopleEntityRolesQuery().where(where).orderBy(desc(peopleEntityRoles.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(peopleEntityRoles).where(where),
    ]);
    res.json({ data: maskPeopleEntityRoles(rows, getViewer(req)), pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/people-entity-roles",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePeopleEntityRoleBody, req.body, res);
    if (!body) return;
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(peopleEntityRoles)
        .values({ id: newId(), ...body })
        .returning();
      if (created?.primaryContact) await demoteOtherPrimaries(tx, created);
      return created;
    });
    res.status(201).json(row);
  }),
);

router.patch(
  "/people-entity-roles/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePeopleEntityRoleBody, req.body, res);
    if (!body) return;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(peopleEntityRoles)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(peopleEntityRoles.id, paramId(req)))
        .returning();
      // Demote whenever the row ends up primary (not just when the body sets
      // it) so moving an already-primary role to another entity can't leave
      // two primaries behind on the destination entity.
      if (updated?.primaryContact) {
        await demoteOtherPrimaries(tx, updated);
      }
      return updated;
    });
    if (!row) return notFound(res, "role");
    res.json(row);
  }),
);

router.delete(
  "/people-entity-roles/:id",
  asyncHandler(async (req, res) => {
    await db.delete(peopleEntityRoles).where(eq(peopleEntityRoles.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
