import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { emails } from "@workspace/db/schema";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import {
  ListEmailsQueryParams,
  CreateEmailBody,
  UpdateEmailBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// An email address is globally unique (case-insensitive) — enforced by the
// emails_email_lower_unique index. Surface the Postgres unique violation
// (SQLSTATE 23505) as a 409 instead of a 500.
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

router.get(
  "/emails",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListEmailsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.personId) filters.push(eq(emails.personId, q.personId));
    
    if (q.organizationId) filters.push(eq(emails.organizationId, q.organizationId));
    if (q.paymentIntermediaryId) filters.push(eq(emails.paymentIntermediaryId, q.paymentIntermediaryId));
    if (q.householdId) filters.push(eq(emails.householdId, q.householdId));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(emails).where(where).orderBy(desc(emails.createdAt)).limit(limit).offset(offset),
      db.select({ value: count() }).from(emails).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/emails",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateEmailBody, req.body, res);
    if (!body) return;
    try {
      const [row] = await db.insert(emails).values({ id: newId(), ...body }).returning();
      res.status(201).json(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "conflict",
          message: `The email address "${body.email}" is already on file. An email can only be attached to one record.`,
        });
        return;
      }
      throw err;
    }
  }),
);

router.patch(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateEmailBody, req.body, res);
    if (!body) return;
    try {
      const [row] = await db
        .update(emails)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(emails.id, paramId(req)))
        .returning();
      if (!row) return notFound(res, "email");
      res.json(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: "conflict",
          message: `The email address "${body.email}" is already on file. An email can only be attached to one record.`,
        });
        return;
      }
      throw err;
    }
  }),
);

router.delete(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    await db.delete(emails).where(eq(emails.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
