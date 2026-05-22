import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { people, peopleEntityRoles, emails, phoneNumbers, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, or, type SQL } from "drizzle-orm";
import {
  ListPeopleQueryParams,
  CreatePersonBody,
  UpdatePersonBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/people",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPeopleQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.search) {
      const term = `%${q.search}%`;
      const orClause = or(
        ilike(people.fullName, term),
        ilike(people.firstName, term),
        ilike(people.lastName, term),
      );
      if (orClause) filters.push(orClause);
    }
    if (q.deceased !== undefined) filters.push(eq(people.deceased, q.deceased));
    if (q.regionId) filters.push(eq(people.currentHomeRegionId, q.regionId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(people).where(where).orderBy(asc(people.lastName), asc(people.firstName)).limit(limit).offset(offset),
      db.select({ value: count() }).from(people).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/people/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(people).where(eq(people.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "person");
    const [roles, emailRows, phoneRows, addressRows] = await Promise.all([
      db.select().from(peopleEntityRoles).where(eq(peopleEntityRoles.personId, id)),
      db.select().from(emails).where(eq(emails.personId, id)),
      db.select().from(phoneNumbers).where(eq(phoneNumbers.personId, id)),
      db.select().from(addresses).where(eq(addresses.personId, id)),
    ]);
    res.json({ ...row, roles, emails: emailRows, phoneNumbers: phoneRows, addresses: addressRows });
  }),
);

router.post(
  "/people",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePersonBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(people).values({ id: newId(), ...body } as any).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/people/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePersonBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(people)
      .set({ ...body, updatedAt: new Date() } as any)
      .where(eq(people.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "person");
    res.json(row);
  }),
);

router.delete(
  "/people/:id",
  asyncHandler(async (req, res) => {
    await db.delete(people).where(eq(people.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
