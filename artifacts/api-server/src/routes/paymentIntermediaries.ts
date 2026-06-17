import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { paymentIntermediaries, peopleEntityRoles, emails, addresses } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, type SQL } from "drizzle-orm";
import {
  ListPaymentIntermediariesQueryParams,
  CreatePaymentIntermediaryBody,
  UpdatePaymentIntermediaryBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";
import { peopleEntityRolesQuery } from "../lib/peopleRolesSelect";
import { activeOnlyUnlessAdmin, archiveOne, unarchiveOne } from "../lib/archive";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/payment-intermediaries",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListPaymentIntermediariesQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.type) filters.push(eq(paymentIntermediaries.type, q.type));
    if (q.search) filters.push(ilike(paymentIntermediaries.name, `%${q.search}%`));
    const archived = activeOnlyUnlessAdmin(req, paymentIntermediaries.archivedAt);
    if (archived) filters.push(archived);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(paymentIntermediaries).where(where).orderBy(asc(paymentIntermediaries.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(paymentIntermediaries).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.get(
  "/payment-intermediaries/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const row = await db.select().from(paymentIntermediaries).where(eq(paymentIntermediaries.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "payment intermediary");
    const [people, emailRows, addressRows] = await Promise.all([
      peopleEntityRolesQuery().where(eq(peopleEntityRoles.paymentIntermediaryId, id)),
      db.select().from(emails).where(eq(emails.paymentIntermediaryId, id)),
      db.select().from(addresses).where(eq(addresses.paymentIntermediaryId, id)),
    ]);
    res.json({ ...row, people, emails: emailRows, addresses: addressRows });
  }),
);

router.post(
  "/payment-intermediaries",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreatePaymentIntermediaryBody, req.body, res);
    if (!body) return;
    const [row] = await db.insert(paymentIntermediaries).values({ id: newId(), ...body }).returning();
    res.status(201).json(row);
  }),
);

router.patch(
  "/payment-intermediaries/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdatePaymentIntermediaryBody, req.body, res);
    if (!body) return;
    const [row] = await db
      .update(paymentIntermediaries)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(paymentIntermediaries.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "payment intermediary");
    res.json(row);
  }),
);

router.post(
  "/payment-intermediaries/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "payment intermediary", table: paymentIntermediaries });
  }),
);

router.post(
  "/payment-intermediaries/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "payment intermediary", table: paymentIntermediaries });
  }),
);

export default router;
