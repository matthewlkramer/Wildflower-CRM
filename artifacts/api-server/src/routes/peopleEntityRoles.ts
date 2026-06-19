import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { peopleEntityRoles } from "@workspace/db/schema";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
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
    const [row] = await db.insert(peopleEntityRoles).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/people-entity-roles/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePeopleEntityRoleBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(peopleEntityRoles)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(peopleEntityRoles.id, paramId(req)))
      .returning();
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
