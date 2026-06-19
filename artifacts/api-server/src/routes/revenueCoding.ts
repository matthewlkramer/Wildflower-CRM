import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  revenueAccounts,
  entityCodingRules,
  entities,
  type EntityCodingRule as EntityCodingRuleRow,
  type RevenueAccount as RevenueAccountRow,
} from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  AdminCreateEntityCodingRuleBody,
  AdminUpdateEntityCodingRuleBody,
  LOCATIONS,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, notFound, paramId, parseOrBadRequest } from "../lib/helpers";

/**
 * Revenue-coding reference data + admin-editable per-entity coding rules.
 *
 *   GET  /revenue-accounts            — the closed Object Code list (any user).
 *   GET  /admin/entity-coding-rules   — per-entity coding defaults (admin only).
 *   POST/PATCH/DELETE on rules        — admin only.
 *
 * Mirrors the QuickBooks-handling-rules admin pattern: a code seed
 * (SEED_ENTITY_CODING_RULES) reproduces today's behavior, the DB rows are
 * editable, and a fidelity test keeps the two in lockstep.
 */

const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): import("@workspace/db/schema").User | null {
  const me = getAppUser(req);
  if (!me || me.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return null;
  }
  return me;
}

function serializeAccount(row: RevenueAccountRow) {
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    payerType: row.payerType ?? null,
    sortOrder: row.sortOrder,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeRule(row: EntityCodingRuleRow) {
  return {
    entityId: row.entityId,
    forceRestricted: row.forceRestricted,
    location: row.location ?? null,
    revenueClass: row.revenueClass ?? null,
    enabled: row.enabled,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const LOCATION_SET = new Set<string>(LOCATIONS);

router.get(
  "/revenue-accounts",
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.activeOnly === "true";
    const rows = await db
      .select()
      .from(revenueAccounts)
      .orderBy(asc(revenueAccounts.sortOrder));
    const data = (activeOnly ? rows.filter((r) => r.active) : rows).map(serializeAccount);
    res.json(data);
  }),
);

router.get(
  "/admin/entity-coding-rules",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await db
      .select()
      .from(entityCodingRules)
      .orderBy(asc(entityCodingRules.entityId));
    res.json(rows.map(serializeRule));
  }),
);

router.post(
  "/admin/entity-coding-rules",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(AdminCreateEntityCodingRuleBody, req.body, res);
    if (!body) return;

    const ent = await db
      .select({ id: entities.id })
      .from(entities)
      .where(eq(entities.id, body.entityId))
      .then((r) => r[0]);
    if (!ent) {
      res.status(400).json({ error: "validation_error", message: "entityId does not match an entity." });
      return;
    }
    if (body.location != null && !LOCATION_SET.has(body.location)) {
      res.status(400).json({ error: "validation_error", message: "location is not in the closed Location list." });
      return;
    }
    const existing = await db
      .select({ entityId: entityCodingRules.entityId })
      .from(entityCodingRules)
      .where(eq(entityCodingRules.entityId, body.entityId))
      .then((r) => r[0]);
    if (existing) {
      res.status(400).json({ error: "validation_error", message: "A coding rule already exists for this entity." });
      return;
    }

    const [row] = await db
      .insert(entityCodingRules)
      .values({
        entityId: body.entityId,
        forceRestricted: body.forceRestricted ?? false,
        location: body.location ?? null,
        revenueClass: body.revenueClass ?? null,
        enabled: body.enabled ?? true,
        notes: body.notes ?? null,
      })
      .returning();
    res.status(201).json(serializeRule(row));
  }),
);

router.patch(
  "/admin/entity-coding-rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const body = parseOrBadRequest(AdminUpdateEntityCodingRuleBody, req.body, res);
    if (!body) return;

    const current = await db
      .select()
      .from(entityCodingRules)
      .where(eq(entityCodingRules.entityId, id))
      .then((r) => r[0]);
    if (!current) return notFound(res, "entity coding rule");

    const location = body.location !== undefined ? body.location : current.location;
    if (location != null && !LOCATION_SET.has(location)) {
      res.status(400).json({ error: "validation_error", message: "location is not in the closed Location list." });
      return;
    }

    const [row] = await db
      .update(entityCodingRules)
      .set({
        forceRestricted: body.forceRestricted ?? current.forceRestricted,
        location: body.location !== undefined ? body.location : current.location,
        revenueClass: body.revenueClass !== undefined ? body.revenueClass : current.revenueClass,
        enabled: body.enabled ?? current.enabled,
        notes: body.notes !== undefined ? body.notes : current.notes,
        updatedAt: new Date(),
      })
      .where(eq(entityCodingRules.entityId, id))
      .returning();
    res.json(serializeRule(row));
  }),
);

router.delete(
  "/admin/entity-coding-rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const current = await db
      .select({ entityId: entityCodingRules.entityId })
      .from(entityCodingRules)
      .where(eq(entityCodingRules.entityId, id))
      .then((r) => r[0]);
    if (!current) return notFound(res, "entity coding rule");
    await db.delete(entityCodingRules).where(eq(entityCodingRules.entityId, id));
    res.json({ ok: true });
  }),
);

export default router;
