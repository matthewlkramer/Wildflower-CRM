import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { organizations, peopleEntityRoles, emails, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import {
  ListOrganizationsQueryParams,
  CreateOrganizationBody,
  UpdateOrganizationBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { peopleEntityRolesQuery } from "../lib/peopleRolesSelect";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/organizations",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListOrganizationsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) filters.push(ilike(organizations.name, `%${q.search}%`));
    if (q.type) filters.push(eq(organizations.type, q.type));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(organizations).where(where).orderBy(asc(organizations.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(organizations).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(organizations).where(eq(organizations.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "organization");
    const [people, emailRows, addressRows] = await Promise.all([
      peopleEntityRolesQuery().where(eq(peopleEntityRoles.organizationId, id)),
      db.select().from(emails).where(eq(emails.organizationId, id)),
      db.select().from(addresses).where(eq(addresses.organizationId, id)),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows });
  }),
);

router.post(
  "/organizations",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateOrganizationBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(organizations).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateOrganizationBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(organizations)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(organizations.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "organization");
    res.json(row);
  }),
);

router.delete(
  "/organizations/:id",
  asyncHandler(async (req, res) => {
    await db.delete(organizations).where(eq(organizations.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
