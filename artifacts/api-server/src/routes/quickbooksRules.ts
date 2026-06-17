import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  quickbooksHandlingRules,
  organizations,
  fundableProjects,
  type QuickbooksHandlingRule,
} from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import {
  AdminCreateQuickbooksRuleBody,
  AdminUpdateQuickbooksRuleBody,
  AdminReorderQuickbooksRulesBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import {
  applyRuleToPendingPayments,
  type ApplyRuleToPendingResult,
} from "../lib/quickbooksSync";
import type {
  EngineRule,
  RuleCondition,
  RuleMatchLogic,
} from "../lib/quickbooksRules";

/**
 * Admin-editable QuickBooks auto-handling rules (the INGEST classifier).
 *
 * Replaces the previously code-only "noise" exclusion list for the sync path:
 * the seed reproduces today's behavior exactly, and admins can add / edit /
 * reorder / enable / delete rules here without a code change. Two actions:
 *   - `exclude`             — mark the row excluded with a reason.
 *   - `auto_create_approve` — mint a gift (donor = targetOrganizationId),
 *                             allocate it (targetIntendedUsage /
 *                             targetFundableProjectId), match + auto-approve.
 *
 * Rules evaluate in ascending `priority`; the first enabled match wins. Editing
 * affects only NEW incoming payments — already-queued rows are never
 * reclassified. Every route is admin-only (403 otherwise).
 */

const router: IRouter = Router();
router.use(requireAuth);

const PRIORITY_STEP = 10;

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

type RuleConditionInput = {
  field: string;
  mode: string;
  value: string;
};

function serialize(row: QuickbooksHandlingRule) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    action: row.action,
    exclusionReason: row.exclusionReason ?? null,
    donationGuard: row.donationGuard,
    matchLogic: row.matchLogic,
    conditions: Array.isArray(row.conditions)
      ? (row.conditions as RuleConditionInput[])
      : [],
    targetOrganizationId: row.targetOrganizationId ?? null,
    targetIntendedUsage: row.targetIntendedUsage ?? null,
    targetFundableProjectId: row.targetFundableProjectId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Semantic validation beyond the Zod shape: action-specific required targets,
 * condition sanity (non-empty, amount⇔lte coupling, valid regex / numeric
 * threshold) and existence of referenced org / project. Returns an error
 * message string (→ 400) or null when the merged rule state is valid.
 */
async function validateRuleSemantics(merged: {
  action: "exclude" | "auto_create_approve";
  exclusionReason?: string | null;
  matchLogic?: string | null;
  conditions: RuleConditionInput[];
  targetOrganizationId?: string | null;
  targetIntendedUsage?: string | null;
  targetFundableProjectId?: string | null;
}): Promise<string | null> {
  if (!Array.isArray(merged.conditions) || merged.conditions.length === 0) {
    return "At least one condition is required.";
  }
  for (const c of merged.conditions) {
    if (!c || typeof c.value !== "string" || c.value.trim() === "") {
      return "Each condition needs a non-empty value.";
    }
    const isAmount = c.field === "amount";
    const isLte = c.mode === "lte";
    if (isAmount !== isLte) {
      return "The 'amount' field must use mode 'lte', and 'lte' applies only to 'amount'.";
    }
    if (isLte && Number.isNaN(Number(c.value))) {
      return "An 'lte' condition value must be numeric.";
    }
    if (c.mode === "regex") {
      try {
        new RegExp(c.value);
      } catch {
        return `Invalid regular expression: ${c.value}`;
      }
    }
  }

  if (merged.action === "exclude") {
    if (!merged.exclusionReason) {
      return "An exclude rule requires an exclusionReason.";
    }
    return null;
  }

  // auto_create_approve
  if (!merged.targetOrganizationId) {
    return "An auto-create rule requires a targetOrganizationId (the gift donor).";
  }
  if (!merged.targetIntendedUsage) {
    return "An auto-create rule requires a targetIntendedUsage for the allocation.";
  }
  const org = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, merged.targetOrganizationId))
    .then((r) => r[0]);
  if (!org) return "targetOrganizationId does not match an organization.";

  if (merged.targetIntendedUsage === "project") {
    if (!merged.targetFundableProjectId) {
      return "A project allocation requires a targetFundableProjectId.";
    }
    const proj = await db
      .select({ id: fundableProjects.id })
      .from(fundableProjects)
      .where(eq(fundableProjects.id, merged.targetFundableProjectId))
      .then((r) => r[0]);
    if (!proj) return "targetFundableProjectId does not match a fundable project.";
  }
  return null;
}

router.get(
  "/admin/quickbooks-rules",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await db
      .select()
      .from(quickbooksHandlingRules)
      .orderBy(asc(quickbooksHandlingRules.priority));
    res.json(rows.map(serialize));
  }),
);

router.post(
  "/admin/quickbooks-rules",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(AdminCreateQuickbooksRuleBody, req.body, res);
    if (!body) return;

    const conditions = (body.conditions ?? []) as RuleConditionInput[];
    const err = await validateRuleSemantics({
      action: body.action,
      exclusionReason: body.exclusionReason ?? null,
      matchLogic: body.matchLogic ?? "any",
      conditions,
      targetOrganizationId: body.targetOrganizationId ?? null,
      targetIntendedUsage: body.targetIntendedUsage ?? null,
      targetFundableProjectId: body.targetFundableProjectId ?? null,
    });
    if (err) {
      res.status(400).json({ error: "validation_error", message: err });
      return;
    }

    // Append at the end of the evaluation order.
    const max = await db
      .select({ priority: quickbooksHandlingRules.priority })
      .from(quickbooksHandlingRules)
      .orderBy(asc(quickbooksHandlingRules.priority));
    const nextPriority =
      (max.length ? Math.max(...max.map((r) => r.priority)) : 0) + PRIORITY_STEP;

    const [row] = await db
      .insert(quickbooksHandlingRules)
      .values({
        id: newId(),
        name: body.name.trim(),
        enabled: body.enabled ?? true,
        priority: nextPriority,
        action: body.action,
        exclusionReason:
          body.action === "exclude" ? body.exclusionReason ?? null : null,
        donationGuard: body.donationGuard ?? false,
        matchLogic: body.matchLogic ?? "any",
        conditions,
        targetOrganizationId:
          body.action === "auto_create_approve"
            ? body.targetOrganizationId ?? null
            : null,
        targetIntendedUsage:
          body.action === "auto_create_approve"
            ? body.targetIntendedUsage ?? null
            : null,
        targetFundableProjectId:
          body.action === "auto_create_approve" &&
          body.targetIntendedUsage === "project"
            ? body.targetFundableProjectId ?? null
            : null,
      })
      .returning();
    res.status(201).json(serialize(row));
  }),
);

router.post(
  "/admin/quickbooks-rules/reorder",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = parseOrBadRequest(
      AdminReorderQuickbooksRulesBody,
      req.body,
      res,
    );
    if (!body) return;

    const ids = body.ids;
    const existing = await db
      .select({ id: quickbooksHandlingRules.id })
      .from(quickbooksHandlingRules);
    const existingIds = new Set(existing.map((r) => r.id));
    if (
      ids.length !== existingIds.size ||
      !ids.every((id) => existingIds.has(id)) ||
      new Set(ids).size !== ids.length
    ) {
      res.status(400).json({
        error: "validation_error",
        message: "ids must be every rule id exactly once.",
      });
      return;
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i += 1) {
        await tx
          .update(quickbooksHandlingRules)
          .set({ priority: (i + 1) * PRIORITY_STEP, updatedAt: new Date() })
          .where(eq(quickbooksHandlingRules.id, ids[i]));
      }
    });

    const rows = await db
      .select()
      .from(quickbooksHandlingRules)
      .orderBy(asc(quickbooksHandlingRules.priority));
    res.json(rows.map(serialize));
  }),
);

router.patch(
  "/admin/quickbooks-rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const body = parseOrBadRequest(AdminUpdateQuickbooksRuleBody, req.body, res);
    if (!body) return;

    const current = await db
      .select()
      .from(quickbooksHandlingRules)
      .where(eq(quickbooksHandlingRules.id, id))
      .then((r) => r[0]);
    if (!current) return notFound(res, "quickbooks rule");

    // Validate the MERGED post-update state (a partial PATCH can otherwise leave
    // an action without its required targets).
    const action = body.action ?? current.action;
    const exclusionReason =
      body.exclusionReason !== undefined
        ? body.exclusionReason
        : current.exclusionReason;
    const matchLogic = body.matchLogic ?? current.matchLogic;
    const conditions = (
      body.conditions !== undefined ? body.conditions : current.conditions
    ) as RuleConditionInput[];
    const targetOrganizationId =
      body.targetOrganizationId !== undefined
        ? body.targetOrganizationId
        : current.targetOrganizationId;
    const targetIntendedUsage =
      body.targetIntendedUsage !== undefined
        ? body.targetIntendedUsage
        : current.targetIntendedUsage;
    const targetFundableProjectId =
      body.targetFundableProjectId !== undefined
        ? body.targetFundableProjectId
        : current.targetFundableProjectId;

    const err = await validateRuleSemantics({
      action,
      exclusionReason: exclusionReason ?? null,
      matchLogic,
      conditions: Array.isArray(conditions) ? conditions : [],
      targetOrganizationId: targetOrganizationId ?? null,
      targetIntendedUsage: targetIntendedUsage ?? null,
      targetFundableProjectId: targetFundableProjectId ?? null,
    });
    if (err) {
      res.status(400).json({ error: "validation_error", message: err });
      return;
    }

    // Normalize the off-action target fields so a switched action can't leave
    // stale targets behind.
    const [row] = await db
      .update(quickbooksHandlingRules)
      .set({
        name: body.name !== undefined ? body.name.trim() : current.name,
        enabled: body.enabled ?? current.enabled,
        action,
        exclusionReason: action === "exclude" ? exclusionReason ?? null : null,
        donationGuard: body.donationGuard ?? current.donationGuard,
        matchLogic,
        conditions: Array.isArray(conditions) ? conditions : [],
        targetOrganizationId:
          action === "auto_create_approve" ? targetOrganizationId ?? null : null,
        targetIntendedUsage:
          action === "auto_create_approve" ? targetIntendedUsage ?? null : null,
        targetFundableProjectId:
          action === "auto_create_approve" && targetIntendedUsage === "project"
            ? targetFundableProjectId ?? null
            : null,
        updatedAt: new Date(),
      })
      .where(eq(quickbooksHandlingRules.id, id))
      .returning();
    res.json(serialize(row));
  }),
);

router.delete(
  "/admin/quickbooks-rules/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);
    const current = await db
      .select({ id: quickbooksHandlingRules.id })
      .from(quickbooksHandlingRules)
      .where(eq(quickbooksHandlingRules.id, id))
      .then((r) => r[0]);
    if (!current) return notFound(res, "quickbooks rule");
    await db
      .delete(quickbooksHandlingRules)
      .where(eq(quickbooksHandlingRules.id, id));
    res.json({ ok: true });
  }),
);

router.post(
  "/admin/quickbooks-rules/:id/apply-to-pending",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = paramId(req);

    const rawBody = req.body as Record<string, unknown>;
    if (typeof rawBody?.dryRun !== "boolean") {
      res.status(400).json({ error: "validation_error", message: "dryRun must be a boolean." });
      return;
    }
    const dryRun: boolean = rawBody.dryRun;

    const row = await db
      .select()
      .from(quickbooksHandlingRules)
      .where(eq(quickbooksHandlingRules.id, id))
      .then((r) => r[0]);
    if (!row) return notFound(res, "quickbooks rule");

    // Convert the DB row to the engine shape (same as loadHandlingRules in sync).
    const engineRule: EngineRule = {
      id: row.id,
      enabled: row.enabled,
      priority: row.priority,
      action: row.action,
      exclusionReason: (row.exclusionReason ?? null) as EngineRule["exclusionReason"],
      donationGuard: row.donationGuard,
      matchLogic: (row.matchLogic === "all" ? "all" : "any") as RuleMatchLogic,
      conditions: Array.isArray(row.conditions)
        ? (row.conditions as RuleCondition[])
        : [],
      targetOrganizationId: row.targetOrganizationId ?? null,
      targetIntendedUsage: row.targetIntendedUsage ?? null,
      targetFundableProjectId: row.targetFundableProjectId ?? null,
    };

    const result: ApplyRuleToPendingResult = await applyRuleToPendingPayments(
      engineRule,
      dryRun,
    );
    res.json(result);
  }),
);

export default router;
