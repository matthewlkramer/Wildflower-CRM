import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  donorPaymentIntermediaries,
  donorRoutingPreferences,
  households,
  paymentIntermediaries,
  people,
  peopleEntityRoles,
} from "@workspace/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  GetDonorRoutingParams,
  UpdateDonorRoutingBody,
  UpdateDonorRoutingParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  parseOrBadRequest,
} from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { getViewer, maskName } from "../lib/identityVisibility";
import { recordAudit } from "../lib/audit";
import {
  DonorRoutingCycleError,
  DonorRoutingDepthError,
  donorKey,
  getDirectDonorPreference,
  loadDonorNode,
  resolveDonorRouting,
  sourceSql,
  type DonorKind,
  type DonorNode,
  type DonorRef,
  type SqlExecutor,
  type StoredPreference,
} from "../lib/donorRouting";

const router: IRouter = Router();
router.use(requireAuth);

const DONOR_ROUTING_ADVISORY_LOCK_KEY = 728411002;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function donorRef(kind: string, id: string): DonorRef | null {
  return kind === "individual" ||
    kind === "household" ||
    kind === "organization"
    ? { kind, id }
    : null;
}

function donorColumns(ref: DonorRef) {
  return {
    organizationId: ref.kind === "organization" ? ref.id : null,
    individualGiverPersonId: ref.kind === "individual" ? ref.id : null,
    householdId: ref.kind === "household" ? ref.id : null,
  };
}

function targetColumns(target: DonorRef | null) {
  return {
    targetKind: target?.kind ?? null,
    targetPersonId: target?.kind === "individual" ? target.id : null,
    targetHouseholdId: target?.kind === "household" ? target.id : null,
    targetOrganizationId: target?.kind === "organization" ? target.id : null,
  };
}

function sourceColumns(source: DonorRef) {
  return {
    sourceKind: source.kind,
    sourcePersonId: source.kind === "individual" ? source.id : null,
    sourceHouseholdId: source.kind === "household" ? source.id : null,
    sourceOrganizationId: source.kind === "organization" ? source.id : null,
  };
}

function displayNode(node: DonorNode, req: Parameters<typeof getViewer>[0]) {
  const viewer = getViewer(req);
  const name =
    node.kind === "household"
      ? node.name
      : (maskName(
          node.name,
          { anonymous: node.anonymous, ownerUserId: node.ownerUserId },
          viewer,
        ) ?? "Anonymous");
  return { kind: node.kind, id: node.id, name };
}

async function defaultIntermediary(source: DonorRef) {
  const donor = donorColumns(source);
  const donorWhere = donor.organizationId
    ? eq(donorPaymentIntermediaries.organizationId, donor.organizationId)
    : donor.individualGiverPersonId
      ? eq(
          donorPaymentIntermediaries.individualGiverPersonId,
          donor.individualGiverPersonId,
        )
      : eq(donorPaymentIntermediaries.householdId, donor.householdId as string);
  const [row] = await db
    .select({
      id: paymentIntermediaries.id,
      name: paymentIntermediaries.name,
      type: paymentIntermediaries.type,
    })
    .from(donorPaymentIntermediaries)
    .innerJoin(
      paymentIntermediaries,
      eq(
        paymentIntermediaries.id,
        donorPaymentIntermediaries.paymentIntermediaryId,
      ),
    )
    .where(and(donorWhere, eq(donorPaymentIntermediaries.isDefault, true)))
    .limit(1);
  return row ?? null;
}

async function primaryHousehold(source: DonorRef) {
  if (source.kind !== "individual") return null;
  const [row] = await db
    .select({ id: households.id, name: households.name })
    .from(people)
    .leftJoin(households, eq(households.id, people.primaryHouseholdId))
    .where(eq(people.id, source.id))
    .limit(1);
  return row?.id ? row : null;
}

async function serializeSettings(
  req: Parameters<typeof getViewer>[0],
  source: DonorRef,
) {
  const sourceNode = await loadDonorNode(db as unknown as SqlExecutor, source);
  if (!sourceNode) return null;
  const direct = await getDirectDonorPreference(
    db as unknown as SqlExecutor,
    source,
  );
  const resolution = await resolveDonorRouting(source);
  const targetNode =
    direct?.mode === "target" && direct.target
      ? await loadDonorNode(db as unknown as SqlExecutor, direct.target)
      : null;
  const [household, intermediary] = await Promise.all([
    primaryHousehold(source),
    defaultIntermediary(source),
  ]);
  return {
    source: displayNode(sourceNode, req),
    mode: direct?.mode ?? "self",
    target: targetNode ? displayNode(targetNode, req) : null,
    resolved: resolution.resolved
      ? displayNode(resolution.resolved, req)
      : null,
    path: resolution.path.map((node) => displayNode(node, req)),
    requiresDecision: resolution.requiresDecision,
    primaryHousehold: household,
    defaultPaymentIntermediary: intermediary,
  };
}

async function syncPrimaryHousehold(
  tx: Tx,
  personId: string,
  householdId: string | null,
) {
  await tx
    .update(people)
    .set({ primaryHouseholdId: householdId, updatedAt: new Date() })
    .where(eq(people.id, personId));

  if (!householdId) {
    await tx
      .update(peopleEntityRoles)
      .set({ current: "past", updatedAt: new Date() })
      .where(
        and(
          eq(peopleEntityRoles.personId, personId),
          eq(peopleEntityRoles.entityType, "household"),
          eq(peopleEntityRoles.current, "current"),
        ),
      );
    return;
  }

  await tx
    .update(peopleEntityRoles)
    .set({ current: "past", updatedAt: new Date() })
    .where(
      and(
        eq(peopleEntityRoles.personId, personId),
        eq(peopleEntityRoles.entityType, "household"),
        eq(peopleEntityRoles.current, "current"),
        ne(peopleEntityRoles.householdId, householdId),
      ),
    );
  const [existing] = await tx
    .select()
    .from(peopleEntityRoles)
    .where(
      and(
        eq(peopleEntityRoles.personId, personId),
        eq(peopleEntityRoles.householdId, householdId),
      ),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(peopleEntityRoles)
      .set({ current: "current", updatedAt: new Date() })
      .where(eq(peopleEntityRoles.id, existing.id));
  } else {
    await tx.insert(peopleEntityRoles).values({
      id: newId(),
      personId,
      entityType: "household",
      householdId,
      current: "current",
    });
  }
}

async function setDefaultIntermediary(
  tx: Tx,
  source: DonorRef,
  paymentIntermediaryId: string | null,
) {
  const donor = donorColumns(source);
  const donorWhere = donor.organizationId
    ? eq(donorPaymentIntermediaries.organizationId, donor.organizationId)
    : donor.individualGiverPersonId
      ? eq(
          donorPaymentIntermediaries.individualGiverPersonId,
          donor.individualGiverPersonId,
        )
      : eq(donorPaymentIntermediaries.householdId, donor.householdId as string);
  await tx
    .update(donorPaymentIntermediaries)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(donorWhere, eq(donorPaymentIntermediaries.isDefault, true)));
  if (!paymentIntermediaryId) return;

  const [pi] = await tx
    .select({
      id: paymentIntermediaries.id,
      archivedAt: paymentIntermediaries.archivedAt,
    })
    .from(paymentIntermediaries)
    .where(eq(paymentIntermediaries.id, paymentIntermediaryId))
    .limit(1);
  if (!pi || pi.archivedAt) throw new Error("default_intermediary_unavailable");

  const [existing] = await tx
    .select({ id: donorPaymentIntermediaries.id })
    .from(donorPaymentIntermediaries)
    .where(
      and(
        donorWhere,
        eq(
          donorPaymentIntermediaries.paymentIntermediaryId,
          paymentIntermediaryId,
        ),
      ),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(donorPaymentIntermediaries)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(donorPaymentIntermediaries.id, existing.id));
  } else {
    await tx.insert(donorPaymentIntermediaries).values({
      id: newId(),
      ...donor,
      paymentIntermediaryId,
      isDefault: true,
    });
  }
}

router.get(
  "/donor-routing/:sourceKind/:sourceId",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(GetDonorRoutingParams, req.params, res);
    if (!params) return;
    const source = donorRef(params.sourceKind, params.sourceId);
    if (!source) {
      res
        .status(400)
        .json({ error: "invalid_donor_kind", message: "Invalid donor kind." });
      return;
    }
    const settings = await serializeSettings(req, source);
    if (!settings) return notFound(res, "donor");
    res.json(settings);
  }),
);

router.put(
  "/donor-routing/:sourceKind/:sourceId",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(UpdateDonorRoutingParams, req.params, res);
    const body = parseOrBadRequest(UpdateDonorRoutingBody, req.body, res);
    if (!params || !body) return;
    const source = donorRef(params.sourceKind, params.sourceId);
    if (!source) {
      res
        .status(400)
        .json({ error: "invalid_donor_kind", message: "Invalid donor kind." });
      return;
    }
    const sourceNode = await loadDonorNode(
      db as unknown as SqlExecutor,
      source,
    );
    if (!sourceNode) return notFound(res, "donor");
    if (sourceNode.archived) {
      res.status(409).json({
        error: "donor_archived",
        message: "Restore this donor before changing its preferred pathway.",
      });
      return;
    }

    const target =
      body.mode === "target" && body.targetKind && body.targetId
        ? donorRef(body.targetKind, body.targetId)
        : null;
    if (body.mode === "target" && !target) {
      res.status(400).json({
        error: "target_required",
        message: "Choose the donor record this pathway should use.",
      });
      return;
    }
    if (target && donorKey(target) === donorKey(source)) {
      res.status(400).json({
        error: "self_target",
        message:
          "Use the 'This record' option instead of pointing a donor to itself.",
      });
      return;
    }
    if (target) {
      const targetNode = await loadDonorNode(
        db as unknown as SqlExecutor,
        target,
      );
      if (!targetNode || targetNode.archived) {
        res.status(409).json({
          error: "target_unavailable",
          message: "The preferred donor target is missing or archived.",
        });
        return;
      }
    }
    if (source.kind !== "individual" && body.primaryHouseholdId) {
      res.status(400).json({
        error: "primary_household_not_allowed",
        message: "Only an individual can have a primary household.",
      });
      return;
    }
    if (body.primaryHouseholdId) {
      const [household] = await db
        .select({ id: households.id, archivedAt: households.archivedAt })
        .from(households)
        .where(eq(households.id, body.primaryHouseholdId))
        .limit(1);
      if (!household || household.archivedAt) {
        res.status(409).json({
          error: "primary_household_unavailable",
          message: "The selected primary household is missing or archived.",
        });
        return;
      }
    }

    const proposed: StoredPreference | null =
      body.mode === "self"
        ? null
        : body.mode === "ask"
          ? { mode: "ask", target: null }
          : { mode: "target", target };
    try {
      await resolveDonorRouting(source, db as unknown as SqlExecutor, {
        source,
        preference: proposed,
      });
    } catch (error) {
      if (error instanceof DonorRoutingCycleError) {
        res.status(409).json({
          error: "donor_routing_cycle",
          message:
            "That change would create a circular preferred donor pathway.",
        });
        return;
      }
      if (error instanceof DonorRoutingDepthError) {
        res.status(409).json({
          error: "donor_routing_too_deep",
          message: "That preferred donor pathway is too long.",
        });
        return;
      }
      throw error;
    }

    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${DONOR_ROUTING_ADVISORY_LOCK_KEY})`,
        );
        // Recheck after serialization. Two different sources can otherwise race
        // into a cycle even though each request passed its preflight check.
        await resolveDonorRouting(source, tx as unknown as SqlExecutor, {
          source,
          preference: proposed,
        });
        const before = await getDirectDonorPreference(
          tx as unknown as SqlExecutor,
          source,
        );
        await tx.execute(
          sql`DELETE FROM donor_routing_preferences WHERE ${sourceSql(source)}`,
        );
        const actor = getAppUser(req);
        if (proposed) {
          await tx.insert(donorRoutingPreferences).values({
            id: newId(),
            ...sourceColumns(source),
            mode: proposed.mode,
            ...targetColumns(proposed.target),
            updatedByUserId: actor?.id ?? null,
          });
        }
        if (source.kind === "individual") {
          await syncPrimaryHousehold(
            tx,
            source.id,
            body.primaryHouseholdId ?? null,
          );
        }
        await setDefaultIntermediary(
          tx,
          source,
          body.defaultPaymentIntermediaryId ?? null,
        );
        await recordAudit(tx, req, {
          action: "update",
          entityType: source.kind === "individual" ? "person" : source.kind,
          entityId: source.id,
          summary: `Updated preferred donor settings for ${sourceNode.name}`,
          metadata: {
            donorRouting: {
              before,
              after: proposed,
              primaryHouseholdId: body.primaryHouseholdId ?? null,
              defaultPaymentIntermediaryId:
                body.defaultPaymentIntermediaryId ?? null,
            },
          },
        });
      });
    } catch (error) {
      if (error instanceof DonorRoutingCycleError) {
        res.status(409).json({
          error: "donor_routing_cycle",
          message:
            "That change would create a circular preferred donor pathway.",
        });
        return;
      }
      if (error instanceof DonorRoutingDepthError) {
        res.status(409).json({
          error: "donor_routing_too_deep",
          message: "That preferred donor pathway is too long.",
        });
        return;
      }
      if (
        error instanceof Error &&
        error.message === "default_intermediary_unavailable"
      ) {
        res.status(409).json({
          error: "default_intermediary_unavailable",
          message: "The selected payment intermediary is missing or archived.",
        });
        return;
      }
      throw error;
    }

    const settings = await serializeSettings(req, source);
    if (!settings) return notFound(res, "donor");
    res.json(settings);
  }),
);

export default router;
