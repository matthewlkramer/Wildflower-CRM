import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { donorRoutingPreferences } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
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
  type DonorNode,
  type DonorRef,
  type SqlExecutor,
  type StoredPreference,
} from "../lib/donorRouting";

const router: IRouter = Router();
router.use(requireAuth);

const DONOR_ROUTING_ADVISORY_LOCK_KEY = 728411002;

function donorRef(kind: string, id: string): DonorRef | null {
  return kind === "individual" ||
    kind === "household" ||
    kind === "organization"
    ? { kind, id }
    : null;
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
  return {
    source: displayNode(sourceNode, req),
    mode: direct?.mode ?? "automatic",
    target: targetNode ? displayNode(targetNode, req) : null,
    resolved: resolution.resolved
      ? displayNode(resolution.resolved, req)
      : null,
    path: resolution.path.map((node) => displayNode(node, req)),
    requiresDecision: resolution.requiresDecision,
  };
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
    const proposed: StoredPreference | null =
      body.mode === "automatic"
        ? null
        : body.mode === "self"
          ? { mode: "self", target: null }
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
        await recordAudit(tx, req, {
          action: "update",
          entityType: source.kind === "individual" ? "person" : source.kind,
          entityId: source.id,
          summary: `Updated default donor of record for ${sourceNode.name}`,
          metadata: {
            donorRouting: {
              before,
              after: proposed,
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
      throw error;
    }

    const settings = await serializeSettings(req, source);
    if (!settings) return notFound(res, "donor");
    res.json(settings);
  }),
);

export default router;
