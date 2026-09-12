import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { newsletterPreferenceEvents, people } from "@workspace/db/schema";
import { CreateNewsletterPreferenceEventBody } from "@workspace/api-zod";
import { desc, eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import {
  asyncHandler,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { recordNewsletterPreference } from "../lib/newsletterPreferences";
import { syncPersonToFlodeskInBackground } from "../lib/flodeskSync";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();
router.use(requireAuth);
router.get(
  "/people/:id/newsletter-preferences",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const person = await db
      .select({
        newsletter: people.newsletter,
        unsubscribedToNewsletter: people.unsubscribedToNewsletter,
      })
      .from(people)
      .where(eq(people.id, id))
      .then((r) => r[0]);
    if (!person) return notFound(res, "person");
    const data = await db
      .select()
      .from(newsletterPreferenceEvents)
      .where(eq(newsletterPreferenceEvents.personId, id))
      .orderBy(
        desc(newsletterPreferenceEvents.recordedAt),
        desc(newsletterPreferenceEvents.id),
      );
    res.json({ ...person, data });
  }),
);
router.post(
  "/people/:id/newsletter-preferences",
  asyncHandler(async (req, res) => {
    const actor = getAppUser(req);
    if (!actor || actor.role === "read_only") {
      res.status(403).json({ error: "write_permission_required" });
      return;
    }
    const body = parseOrBadRequest(
      CreateNewsletterPreferenceEventBody,
      req.body,
      res,
    );
    if (!body) return;
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : null;
    if (
      !body.source.trim() ||
      !body.evidence.trim() ||
      (occurredAt &&
        (!Number.isFinite(occurredAt.getTime()) ||
          occurredAt.getTime() > Date.now()))
    ) {
      res
        .status(400)
        .json({
          error: "evidence_required",
          message:
            "Provide source evidence. If the event date is known, it must be valid and cannot be in the future.",
        });
      return;
    }
    if (body.sourceUrl && !/^https?:\/\//i.test(body.sourceUrl)) {
      res
        .status(400)
        .json({
          error: "invalid_source_url",
          message: "Evidence links must use http or https.",
        });
      return;
    }
    const id = paramId(req);
    const exists = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, id))
      .then((r) => r[0]);
    if (!exists) return notFound(res, "person");
    const row = await db.transaction(async (tx) => {
      const event = await recordNewsletterPreference(
        tx,
        {
          personId: id,
          eventType: body.eventType,
          occurredAt,
          source: body.source.trim(),
          sourceKey: `manual:${actor.id}:${body.requestId}`,
          sourceUrl: body.sourceUrl ?? null,
          evidence: body.evidence.trim(),
          recordedByUserId: actor.id,
        },
        async (inserted) => {
          await recordAudit(tx, req, {
            action: "newsletter_preference_recorded",
            entityType: "person",
            entityId: id,
            summary: "Recorded newsletter preference evidence",
            metadata: {
              eventId: inserted.id,
              eventType: inserted.eventType,
              source: inserted.source,
            },
          });
        },
      );
      return event;
    });
    syncPersonToFlodeskInBackground(id);
    res.status(201).json(row);
  }),
);
export default router;
