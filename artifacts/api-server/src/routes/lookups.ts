import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { fundableProjects, fiscalYears } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import { CreateFundableProjectBody, UpdateFundableProjectBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, paramId, parseOrBadRequest } from "../lib/helpers";

// NOTE: /entities (GET/POST/PATCH) and /fiscal-year-entity-goals routes live
// in their own files (entities.ts, fiscalYearEntityGoals.ts). This file holds
// the read-only fiscal-years lookup plus full CRUD for fundable-projects.
const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/fundable-projects",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(fundableProjects).orderBy(asc(fundableProjects.name));
    res.json(rows);
  }),
);

router.get(
  "/fundable-projects/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(fundableProjects)
      .where(eq(fundableProjects.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "fundable project");
    res.json(row);
  }),
);

// Slug-style id is user-provided (not auto-generated) — fundable projects are a
// small curated set keyed by stable slugs referenced from allocation rows via
// fundable_project_id. Validate the shape and surface a 409 on PK collision so
// the admin UI can show a clear "already exists" message.
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

router.post(
  "/fundable-projects",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateFundableProjectBody, req.body, res);
    if (!body) return;
    if (!SLUG_RE.test(body.id)) {
      res.status(400).json({
        error: "validation_error",
        message:
          "Fundable project id must be lowercase alphanumeric + underscore, starting with a letter or digit.",
      });
      return;
    }
    // Race-safe: rely on the PK unique constraint and map the pg unique
    // violation (SQLSTATE 23505) to a 409 instead of a 500.
    try {
      const [row] = await db.insert(fundableProjects).values(body).returning();
      res.status(201).json(row);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "conflict", message: `Fundable project '${body.id}' already exists.` });
        return;
      }
      throw err;
    }
  }),
);

router.patch(
  "/fundable-projects/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateFundableProjectBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const [row] = await db
      .update(fundableProjects)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(fundableProjects.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "fundable project");
    res.json(row);
  }),
);

router.get(
  "/fiscal-years",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(fiscalYears).orderBy(asc(fiscalYears.id));
    res.json(rows);
  }),
);

export default router;
