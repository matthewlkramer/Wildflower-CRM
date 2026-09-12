import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import {
  enrichmentSuggestions,
  organizations,
  people,
  regions,
} from "@workspace/db/schema";
import { ResolveEnrichmentSuggestionBody } from "@workspace/api-zod";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { recordAudit } from "../lib/audit";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import {
  runExternalEnrichmentStubs,
  runPersonRegionEnrichment,
} from "../lib/enrichment";

const router: IRouter = Router();
router.use(requireAuth);

type EntityType = "person" | "organization";

class EnrichmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function canResolve(req: Request, ownerUserId: string | null): boolean {
  const actor = getAppUser(req);
  return Boolean(
    actor?.id && (actor.role === "admin" || actor.id === ownerUserId),
  );
}

async function entityOwner(
  entityType: EntityType,
  entityId: string,
): Promise<string | null | undefined> {
  if (entityType === "person") {
    return db
      .select({ ownerUserId: people.ownerUserId })
      .from(people)
      .where(eq(people.id, entityId))
      .then((rows) => rows[0]?.ownerUserId);
  }
  return db
    .select({ ownerUserId: organizations.ownerUserId })
    .from(organizations)
    .where(eq(organizations.id, entityId))
    .then((rows) => rows[0]?.ownerUserId);
}

async function listPending(
  req: Request,
  entityType: EntityType,
  entityId: string,
) {
  const ownerUserId = await entityOwner(entityType, entityId);
  if (ownerUserId === undefined) return undefined;
  const rows = await db
    .select()
    .from(enrichmentSuggestions)
    .where(
      and(
        eq(enrichmentSuggestions.entityType, entityType),
        eq(enrichmentSuggestions.entityId, entityId),
        eq(enrichmentSuggestions.status, "pending"),
      ),
    )
    .orderBy(asc(enrichmentSuggestions.createdAt));
  return {
    data: rows.map((row) => ({
      ...row,
      viewerCanResolve: canResolve(req, ownerUserId),
    })),
  };
}

router.get(
  "/people/:id/enrichment-suggestions",
  asyncHandler(async (req, res) => {
    const result = await listPending(req, "person", paramId(req));
    if (!result) return notFound(res, "person");
    res.json(result);
  }),
);

router.post(
  "/people/:id/enrich",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    if (!(await runPersonRegionEnrichment(id))) return notFound(res, "person");
    await runExternalEnrichmentStubs("person", id);
    const result = await listPending(req, "person", id);
    res.json(result);
  }),
);

router.get(
  "/organizations/:id/enrichment-suggestions",
  asyncHandler(async (req, res) => {
    const result = await listPending(req, "organization", paramId(req));
    if (!result) return notFound(res, "organization");
    res.json(result);
  }),
);

router.post(
  "/organizations/:id/enrich",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const org = await db
      .select({ id: organizations.id, regionIds: organizations.regionIds })
      .from(organizations)
      .where(eq(organizations.id, id))
      .then((rows) => rows[0]);
    if (!org) return notFound(res, "organization");
    await runExternalEnrichmentStubs("organization", id);
    const result = await listPending(req, "organization", id);
    res.json(result);
  }),
);

router.patch(
  "/enrichment-suggestions/:id",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(
      ResolveEnrichmentSuggestionBody,
      req.body,
      res,
    );
    if (!body) return;
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }

    try {
      const resolved = await db.transaction(async (tx) => {
        const suggestion = await tx
          .select()
          .from(enrichmentSuggestions)
          .where(eq(enrichmentSuggestions.id, paramId(req)))
          .for("update")
          .then((rows) => rows[0]);
        if (!suggestion) {
          throw new EnrichmentError(404, "not_found", "Suggestion not found.");
        }
        if (suggestion.status !== "pending") {
          throw new EnrichmentError(
            409,
            "suggestion_resolved",
            "This suggestion has already been resolved.",
          );
        }

        const now = new Date();
        let ownerUserId: string | null;
        if (suggestion.entityType === "person") {
          if (suggestion.fieldName !== "currentHomeRegionId") {
            throw new EnrichmentError(
              409,
              "unsupported_suggestion",
              "This person suggestion targets an unsupported field.",
            );
          }
          const person = await tx
            .select({
              ownerUserId: people.ownerUserId,
              currentHomeRegionId: people.currentHomeRegionId,
            })
            .from(people)
            .where(eq(people.id, suggestion.entityId))
            .for("update")
            .then((rows) => rows[0]);
          if (!person) {
            throw new EnrichmentError(404, "not_found", "Person not found.");
          }
          ownerUserId = person.ownerUserId;
          if (!canResolve(req, ownerUserId)) {
            throw new EnrichmentError(
              403,
              "record_owner_required",
              "Only the record owner or an admin can resolve this suggestion.",
            );
          }
          if (body.status === "accepted") {
            if (person.currentHomeRegionId) {
              throw new EnrichmentError(
                409,
                "canonical_value_present",
                "Home region was filled after this suggestion was created.",
              );
            }
            const regionExists = await tx
              .select({ id: regions.id })
              .from(regions)
              .where(
                and(
                  eq(regions.id, suggestion.suggestedValue.regionId),
                  isNull(regions.archivedAt),
                ),
              )
              .then((rows) => rows[0]);
            if (!regionExists) {
              throw new EnrichmentError(
                409,
                "suggested_value_stale",
                "The suggested region is no longer available.",
              );
            }
            await tx
              .update(people)
              .set({
                currentHomeRegionId: suggestion.suggestedValue.regionId,
                updatedAt: now,
              })
              .where(eq(people.id, suggestion.entityId));
            await recordAudit(tx, req, {
              action: "field_enriched",
              entityType: "person",
              entityId: suggestion.entityId,
              summary: "Accepted CRM enrichment suggestion",
              changes: [
                {
                  field: "currentHomeRegionId",
                  from: null,
                  to: suggestion.suggestedValue.regionId,
                },
              ],
              metadata: {
                suggestionId: suggestion.id,
                sourceLabel: suggestion.sourceLabel,
              },
            });
          }
        } else if (suggestion.entityType === "organization") {
          if (suggestion.fieldName !== "regionIds") {
            throw new EnrichmentError(
              409,
              "unsupported_suggestion",
              "This organization suggestion targets an unsupported field.",
            );
          }
          const organization = await tx
            .select({
              ownerUserId: organizations.ownerUserId,
              regionIds: organizations.regionIds,
            })
            .from(organizations)
            .where(eq(organizations.id, suggestion.entityId))
            .for("update")
            .then((rows) => rows[0]);
          if (!organization) {
            throw new EnrichmentError(
              404,
              "not_found",
              "Organization not found.",
            );
          }
          ownerUserId = organization.ownerUserId;
          if (!canResolve(req, ownerUserId)) {
            throw new EnrichmentError(
              403,
              "record_owner_required",
              "Only the record owner or an admin can resolve this suggestion.",
            );
          }
          if (body.status === "accepted") {
            throw new EnrichmentError(
              409,
              "funding_interest_evidence_required",
              "Office location does not establish funding interests. Dismiss this address suggestion and enter confirmed funding regions on the organization.",
            );
          }
        } else {
          throw new EnrichmentError(
            409,
            "unsupported_suggestion",
            "This suggestion type is not supported.",
          );
        }

        if (body.status === "dismissed") {
          await recordAudit(tx, req, {
            action: "field_enrichment_dismissed",
            entityType: suggestion.entityType,
            entityId: suggestion.entityId,
            summary: "Dismissed CRM enrichment suggestion",
            metadata: {
              suggestionId: suggestion.id,
              fieldName: suggestion.fieldName,
              sourceLabel: suggestion.sourceLabel,
            },
          });
        }
        const updated = await tx
          .update(enrichmentSuggestions)
          .set({
            status: body.status,
            resolvedAt: now,
            resolvedByUserId: actor.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(enrichmentSuggestions.id, suggestion.id),
              eq(enrichmentSuggestions.status, "pending"),
            ),
          )
          .returning()
          .then((rows) => rows[0]);
        if (!updated) {
          throw new EnrichmentError(
            409,
            "suggestion_resolved",
            "This suggestion has already been resolved.",
          );
        }
        return { ...updated, viewerCanResolve: true };
      });
      res.json(resolved);
    } catch (error) {
      if (error instanceof EnrichmentError) {
        res
          .status(error.status)
          .json({ error: error.code, message: error.message });
        return;
      }
      throw error;
    }
  }),
);

export default router;
