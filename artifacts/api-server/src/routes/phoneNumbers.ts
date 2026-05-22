import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { phoneNumbers } from "@workspace/db/schema";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import {
  ListPhoneNumbersQueryParams,
  CreatePhoneNumberBody,
  UpdatePhoneNumberBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/phone-numbers",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPhoneNumbersQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.personId) filters.push(eq(phoneNumbers.personId, q.personId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(phoneNumbers).where(where).orderBy(desc(phoneNumbers.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(phoneNumbers).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/phone-numbers",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePhoneNumberBody, req.body, res);
    if (!body) return;
    // personId is NOT NULL at the DB level (see lib/db/src/schema/phoneNumbers.ts).
    // The generated zod body type still marks it optional because the OpenAPI
    // spec rewrite is part of pending Stage 2; guard at runtime until then.
    if (!body.personId) {
      res.status(400).json({ error: "personId is required" });
      return;
    }
    const [row] = await db
      .insert(phoneNumbers)
      .values({ id: newId(), ...body, personId: body.personId })
      .returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/phone-numbers/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePhoneNumberBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(phoneNumbers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(phoneNumbers.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "phone number");
    res.json(row);
  }),
);

router.delete(
  "/phone-numbers/:id",
  asyncHandler(async (req, res) => {
    await db.delete(phoneNumbers).where(eq(phoneNumbers.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
