import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { regionAliases, regionMemberships, regions } from "@workspace/db/schema";
import { and, asc, count, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  CreateRegionBody,
  GetRegionContainmentQueryParams,
  ListRegionsQueryParams,
  UpdateRegionBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  normalizeArrayQuery,
  notFound,
  parseOrBadRequest,
  parsePagination,
  paramId,
} from "../lib/helpers";
import { activeOnlyUnlessAdmin, archiveOne, isAdmin, requireAdmin, unarchiveOne } from "../lib/archive";
import {
  deriveContainment,
  recomputeDisplayPaths,
  wouldFinalGraphCycle,
} from "../lib/regionContainment";

const router: IRouter = Router();
router.use(requireAuth);

/** Region row + aggregated aliases / grouping members for API responses. */
async function attachRegionExtras<T extends { id: string }>(rows: T[]) {
  if (rows.length === 0) return rows.map((r) => ({ ...r, aliases: [], memberRegionIds: [] }));
  const ids = rows.map((r) => r.id);
  const [aliasRows, memberRows] = await Promise.all([
    db
      .select({ regionId: regionAliases.regionId, alias: regionAliases.alias })
      .from(regionAliases)
      .where(inArray(regionAliases.regionId, ids))
      .orderBy(asc(regionAliases.alias)),
    db
      .select({
        containerRegionId: regionMemberships.containerRegionId,
        memberRegionId: regionMemberships.memberRegionId,
      })
      .from(regionMemberships)
      .where(inArray(regionMemberships.containerRegionId, ids))
      .orderBy(asc(regionMemberships.memberRegionId)),
  ]);
  const aliasesById = new Map<string, string[]>();
  for (const a of aliasRows) {
    const list = aliasesById.get(a.regionId) ?? [];
    list.push(a.alias);
    aliasesById.set(a.regionId, list);
  }
  const membersById = new Map<string, string[]>();
  for (const m of memberRows) {
    const list = membersById.get(m.containerRegionId) ?? [];
    list.push(m.memberRegionId);
    membersById.set(m.containerRegionId, list);
  }
  return rows.map((r) => ({
    ...r,
    aliases: aliasesById.get(r.id) ?? [],
    memberRegionIds: membersById.get(r.id) ?? [],
  }));
}

router.get(
  "/regions",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListRegionsQueryParams, req.query, res);
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [];
    if (q.type) filters.push(eq(regions.type, q.type));
    if (q.search) {
      const term = `%${q.search}%`;
      const match = or(
        sql`${regions.name} ILIKE ${term}`,
        sql`${regions.displayPath} ILIKE ${term}`,
        sql`${regions.stateAbbreviation} ILIKE ${term}`,
        sql`EXISTS (SELECT 1 FROM region_aliases ra WHERE ra.region_id = ${regions.id} AND ra.alias ILIKE ${term})`,
      );
      if (match) filters.push(match);
    }
    const archivedFilter = activeOnlyUnlessAdmin(req, regions.archivedAt);
    if (archivedFilter) filters.push(archivedFilter);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
      db.select().from(regions).where(where).orderBy(asc(regions.name)).limit(limit).offset(offset),
      db.select({ value: count() }).from(regions).where(where),
    ]);
    const data = await attachRegionExtras(rows);
    res.json({ data, pagination: { page, limit, total: Number(total) } });
  }),
);

// Containment derivation (single authority): which regions sit inside each
// requested region, recursively over canonical parentage + memberships.
// Registered BEFORE /regions/:id so "containment" never matches as an id.
router.get(
  "/regions/containment",
  asyncHandler(async (req, res) => {
    // normalizeArrayQuery also comma-splits — the generated client sends
    // ?ids=a,b as one joined value, not repeated params.
    const normalized = normalizeArrayQuery(req.query as Record<string, unknown>, ["ids"]);
    if (normalized.ids === undefined) normalized.ids = [];
    const q = parseOrBadRequest(GetRegionContainmentQueryParams, normalized, res);
    if (!q) return;
    if (q.ids.length > 200) {
      res.status(400).json({ error: "validation_error", message: "At most 200 ids per request." });
      return;
    }
    const map = await deriveContainment(q.ids);
    res.json({
      data: q.ids.map((id) => ({ regionId: id, containedRegionIds: map.get(id) ?? [] })),
    });
  }),
);

// Admin-only structured creation. displayPath is derived from canonical
// parentage — clients can no longer supply it (one-click create is retired).
router.post(
  "/regions",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(CreateRegionBody, req.body, res);
    if (!body) return;

    const memberIds = [...new Set(body.memberRegionIds ?? [])];
    const aliases = dedupeAliases(body.aliases ?? []);

    if (body.type === "custom_region") {
      if (body.parentRegionId) {
        res.status(400).json({
          error: "validation_error",
          message: "A custom_region grouping cannot have a parent; its scope comes from its members.",
        });
        return;
      }
      if (memberIds.length === 0) {
        res.status(400).json({
          error: "validation_error",
          message: "A custom_region grouping needs at least one member region.",
        });
        return;
      }
    }

    const slug = nameToSlug(body.name);
    if (!slug) {
      res.status(400).json({ error: "validation_error", message: "Region name must contain at least one letter or digit." });
      return;
    }

    // Referenced regions must exist.
    const refIds = [...new Set([...(body.parentRegionId ? [body.parentRegionId] : []), ...memberIds])];
    if (refIds.length > 0) {
      const found = await db.select({ id: regions.id }).from(regions).where(inArray(regions.id, refIds));
      const foundSet = new Set(found.map((r) => r.id));
      const missing = refIds.filter((id) => !foundSet.has(id));
      if (missing.length > 0) {
        res.status(400).json({ error: "validation_error", message: `Unknown region id(s): ${missing.join(", ")}` });
        return;
      }
    }

    const id = await resolveUniqueSlug(slug);

    // Cycle check against the intended FINAL graph (parent edge + membership
    // edges applied together) — field-by-field pre-state checks miss cycles
    // formed by the combination (e.g. parent P that is also a member).
    if (
      await wouldFinalGraphCycle({
        regionId: id,
        parentRegionId: body.parentRegionId ?? null,
        memberRegionIds: memberIds,
      })
    ) {
      res.status(400).json({
        error: "validation_error",
        message: "That combination of parent and members would create a containment cycle.",
      });
      return;
    }

    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(regions)
        .values({
          id,
          name: body.name,
          // Placeholder; recomputed from parentage inside this transaction.
          displayPath: body.name,
          type: body.type,
          parentRegionId: body.parentRegionId ?? null,
          stateAbbreviation: body.stateAbbreviation ?? null,
        })
        .returning();
      if (memberIds.length > 0) {
        await tx.insert(regionMemberships).values(
          memberIds.map((memberRegionId) => ({ id: newId(), containerRegionId: id, memberRegionId })),
        );
      }
      if (aliases.length > 0) {
        await tx.insert(regionAliases).values(
          aliases.map((alias) => ({ id: newId(), regionId: id, alias })),
        );
      }
      await recomputeDisplayPaths(tx);
      const fresh = await tx.select().from(regions).where(eq(regions.id, id)).then((r) => r[0]);
      return fresh ?? inserted;
    });
    const [withExtras] = await attachRegionExtras([row]);
    res.status(201).json(withExtras);
  }),
);

router.get(
  "/regions/:id",
  asyncHandler(async (req, res) => {
    const row = await db.select().from(regions).where(eq(regions.id, paramId(req))).then((r) => r[0]);
    if (!row) return notFound(res, "region");
    const [withExtras] = await attachRegionExtras([row]);
    res.json(withExtras);
  }),
);

// PATCH: simple scalar fields for any user; parentRegionId / memberRegionIds /
// aliases are admin-only (403 otherwise). displayPath is derived — a name or
// parent change recomputes it for the whole tree.
router.patch(
  "/regions/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(UpdateRegionBody, req.body, res);
    if (!body) return;
    if (Object.keys(body).length === 0) {
      res.status(400).json({ error: "validation_error", message: "Empty update body." });
      return;
    }
    const id = paramId(req);
    const adminOnlyTouched =
      "parentRegionId" in body || "memberRegionIds" in body || "aliases" in body;
    if (adminOnlyTouched && !isAdmin(req)) {
      res.status(403).json({
        error: "forbidden",
        message: "Admin role required to edit region parentage, members, or aliases.",
      });
      return;
    }

    const existing = await db.select().from(regions).where(eq(regions.id, id)).then((r) => r[0]);
    if (!existing) return notFound(res, "region");

    if (body.parentRegionId !== undefined && body.parentRegionId !== null) {
      const parent = await db
        .select({ id: regions.id })
        .from(regions)
        .where(eq(regions.id, body.parentRegionId))
        .then((r) => r[0]);
      if (!parent) {
        res.status(400).json({ error: "validation_error", message: "Unknown parent region." });
        return;
      }
    }

    let memberIds: string[] | undefined;
    if (body.memberRegionIds !== undefined) {
      memberIds = [...new Set(body.memberRegionIds)];
      if (memberIds.includes(id)) {
        res.status(400).json({ error: "validation_error", message: "A region cannot be its own member." });
        return;
      }
      if (memberIds.length > 0) {
        const found = await db.select({ id: regions.id }).from(regions).where(inArray(regions.id, memberIds));
        if (found.length !== memberIds.length) {
          const foundSet = new Set(found.map((r) => r.id));
          res.status(400).json({
            error: "validation_error",
            message: `Unknown region id(s): ${memberIds.filter((m) => !foundSet.has(m)).join(", ")}`,
          });
          return;
        }
      }
    }

    // custom_region structural invariant on the MERGED final state (mirrors
    // POST): a grouping never has a parent and always has ≥1 member. Checked
    // on the merge so a type change, a parent change, or a member wipe can't
    // sneak an invalid shape past create-only validation.
    const finalType = body.type === undefined ? existing.type : body.type;
    if (finalType === "custom_region") {
      const finalParent =
        body.parentRegionId === undefined ? existing.parentRegionId : body.parentRegionId;
      if (finalParent !== null) {
        res.status(400).json({
          error: "validation_error",
          message: "A custom_region grouping cannot have a parent; its scope comes from its members.",
        });
        return;
      }
      let finalMemberCount: number;
      if (memberIds !== undefined) {
        finalMemberCount = memberIds.length;
      } else {
        const [{ value } = { value: 0 }] = await db
          .select({ value: count() })
          .from(regionMemberships)
          .where(eq(regionMemberships.containerRegionId, id));
        finalMemberCount = Number(value);
      }
      if (finalMemberCount === 0) {
        res.status(400).json({
          error: "validation_error",
          message: "A custom_region grouping needs at least one member region.",
        });
        return;
      }
    }

    // Single cycle check against the intended FINAL graph: parent and member
    // changes are validated together, not field-by-field against pre-state
    // (a combined update like parent=P + members=[P] passes both individual
    // checks yet creates a cycle once applied).
    if (body.parentRegionId !== undefined || memberIds !== undefined) {
      if (
        await wouldFinalGraphCycle({
          regionId: id,
          parentRegionId: body.parentRegionId,
          memberRegionIds: memberIds,
        })
      ) {
        res.status(400).json({
          error: "validation_error",
          message: "That combination of parent and members would create a containment cycle.",
        });
        return;
      }
    }

    const { memberRegionIds: _members, aliases: _aliases, ...scalar } = body;
    await db.transaction(async (tx) => {
      if (Object.keys(scalar).length > 0) {
        await tx
          .update(regions)
          .set({ ...scalar, updatedAt: new Date() })
          .where(eq(regions.id, id));
      }
      if (memberIds !== undefined) {
        await tx.delete(regionMemberships).where(eq(regionMemberships.containerRegionId, id));
        if (memberIds.length > 0) {
          await tx.insert(regionMemberships).values(
            memberIds.map((memberRegionId) => ({ id: newId(), containerRegionId: id, memberRegionId })),
          );
        }
      }
      if (body.aliases !== undefined) {
        const aliases = dedupeAliases(body.aliases);
        await tx.delete(regionAliases).where(eq(regionAliases.regionId, id));
        if (aliases.length > 0) {
          await tx.insert(regionAliases).values(
            aliases.map((alias) => ({ id: newId(), regionId: id, alias })),
          );
        }
      }
      if (body.name !== undefined || body.parentRegionId !== undefined) {
        await recomputeDisplayPaths(tx);
      }
    });
    const row = await db.select().from(regions).where(eq(regions.id, id)).then((r) => r[0]);
    if (!row) return notFound(res, "region");
    const [withExtras] = await attachRegionExtras([row]);
    res.json(withExtras);
  }),
);

router.post(
  "/regions/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveOne(req, res, { entity: "region", table: regions });
  }),
);

router.post(
  "/regions/:id/unarchive",
  asyncHandler(async (req, res) => {
    await unarchiveOne(req, res, { entity: "region", table: regions });
  }),
);

export default router;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Case-insensitive dedupe of alias strings, trimmed, empties dropped. */
function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

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
