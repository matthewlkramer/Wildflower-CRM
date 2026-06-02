import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { regions } from "@workspace/db/schema";
import { and, asc, count, eq, ilike, sql, type SQL } from "drizzle-orm";
import { CreateRegionBody, ListRegionsQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, parseOrBadRequest, parsePagination, paramId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/regions",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListRegionsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.type) filters.push(eq(regions.type, q.type));
    if (q.search) filters.push(ilike(regions.name, `%${q.search}%`));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(regions).where(where).orderBy(asc(regions.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(regions).where(where),
    ]);
    res.json({ data: rows, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/regions",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateRegionBody, req.body, res);
    if (!body) return;

    const slug = nameToSlug(body.name);
    if (!slug) {
      res.status(400).json({ error: "Region name must contain at least one letter or digit." });
      return;
    }
    const displayPath = body.displayPath ?? body.name;

    // Try the base slug; if taken, append a short numeric suffix.
    const id = await resolveUniqueSlug(slug);

    const [row] = await db
      .insert(regions)
      .values({ id, name: body.name, displayPath })
      .returning();
    res.status(201).json(row);
  }),
);

router.get(
  "/regions/:id",
  asyncHandler(async (req, res) => {
    const row = await db.select().from(regions).where(eq(regions.id, paramId(req))).then((r) => r[0]);
    if (!row) return notFound(res, "region");
    res.json(row);
  }),
);

export default router;

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a human-readable name to a URL-safe slug:
 * lowercase, spaces→hyphens, collapse runs of non-alphanumeric chars to a
 * single hyphen, strip leading/trailing hyphens.
 * Returns "" when the name contains no letters or digits at all.
 */
function nameToSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Find an unused slug, appending -2, -3 … if the base is already taken. */
async function resolveUniqueSlug(base: string): Promise<string> {
  const existing = await db
    .select({ id: regions.id })
    .from(regions)
    .where(sql`${regions.id} = ${base} OR ${regions.id} LIKE ${base + "-%"}`);
  const taken = new Set(existing.map((r) => r.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
