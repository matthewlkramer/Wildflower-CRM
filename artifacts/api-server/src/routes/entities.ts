import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { entities } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import { CreateEntityBody, UpdateEntityBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, paramId, parseOrBadRequest } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/entities",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(entities).orderBy(asc(entities.name));
    res.json(rows);
  }),
);

router.get(
  "/entities/:id",
  asyncHandler(async (req, res) => {
    const row = await db
      .select()
      .from(entities)
      .where(eq(entities.id, paramId(req)))
      .then((r) => r[0]);
    if (!row) return notFound(res, "entity");
    res.json(row);
  }),
);

// Slug-style id is user-provided (not auto-generated) — entities are a small
// curated set keyed by stable slugs used throughout the schema (entity_id
// columns, opps.entity_ids text[]). Validate the shape and surface a 409 on
// PK collision so the admin UI can show a clear "already exists" message.
const SLUG_RE = /^[a-z0-9][a-z0-9_]*$/;

router.post(
  "/entities",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateEntityBody, req.body, res);
    if (!body) return;
    if (!SLUG_RE.test(body.id)) {
      res.status(400).json({
        error: "validation_error",
        message: "Entity id must be lowercase alphanumeric + underscore, starting with a letter or digit.",
      });
      return;
    }
    // Race-safe: rely on the PK unique constraint and map the pg unique
    // violation (SQLSTATE 23505) to a 409 instead of a 500. Belt-and-braces
    // pre-check is omitted because it cannot prevent the race between two
    // concurrent admins creating the same slug.
    try {
      const [row] = await db.insert(entities).values(body).returning();
      res.status(201).json(row);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
        res.status(409).json({ error: "conflict", message: `Entity '${body.id}' already exists.` });
        return;
      }
      throw err;
    }
  }),
);

router.patch(
  "/entities/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateEntityBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const [row] = await db
      .update(entities)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(entities.id, paramId(req)))
      .returning();
    if (!row) return notFound(res, "entity");
    res.json(row);
  }),
);

export default router;
