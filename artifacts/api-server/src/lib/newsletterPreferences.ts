import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import { newsletterPreferenceEvents, people } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { newId } from "./helpers";

type PreferenceEvent = typeof newsletterPreferenceEvents.$inferInsert;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class NewsletterEvidenceConflict extends Error {
  readonly status = 409;
}

/** Shared, serialized, idempotent write boundary for manual and imported evidence.
 * The database trigger alone derives current audience-selection / suppression. */
export async function recordNewsletterPreference(
  tx: Transaction,
  event: Omit<PreferenceEvent, "id" | "recordedAt">,
  onInserted?: (
    event: typeof newsletterPreferenceEvents.$inferSelect,
  ) => Promise<void>,
) {
  const person = await tx
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, event.personId))
    .for("update")
    .then((rows) => rows[0]);
  if (!person) throw new Error("Person not found");
  const [inserted] = await tx
    .insert(newsletterPreferenceEvents)
    .values({ ...event, id: newId() })
    .onConflictDoNothing({ target: newsletterPreferenceEvents.sourceKey })
    .returning();
  if (inserted) {
    await onInserted?.(inserted);
    return inserted;
  }
  const existing = await tx
    .select()
    .from(newsletterPreferenceEvents)
    .where(eq(newsletterPreferenceEvents.sourceKey, event.sourceKey))
    .then((rows) => rows[0]);
  if (
    !existing ||
    existing.personId !== event.personId ||
    existing.eventType !== event.eventType ||
    existing.evidence !== event.evidence ||
    existing.source !== event.source ||
    existing.sourceUrl !== (event.sourceUrl ?? null) ||
    (existing.occurredAt?.toISOString() ?? null) !==
      (event.occurredAt?.toISOString() ?? null)
  ) {
    throw new NewsletterEvidenceConflict(
      "Newsletter evidence conflicts with an existing source record; review before importing.",
    );
  }
  return existing;
}

/** An observed provider suppression has unknown event time/initiator unless the
 * provider supplies them. Repeated observations do not fabricate new opt-outs. */
export async function recordFlodeskUnsubscribe(
  personId: string,
  email: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const person = await tx
      .select()
      .from(people)
      .where(eq(people.id, personId))
      .for("update")
      .then((r) => r[0]);
    if (!person || person.unsubscribedToNewsletter) return false;
    const latest = await tx
      .select({ id: newsletterPreferenceEvents.id })
      .from(newsletterPreferenceEvents)
      .where(eq(newsletterPreferenceEvents.personId, personId))
      .orderBy(
        desc(newsletterPreferenceEvents.recordedAt),
        desc(newsletterPreferenceEvents.id),
      )
      .limit(1);
    const key = createHash("sha256")
      .update(`${email.toLowerCase()}:${latest[0]?.id ?? "initial"}`)
      .digest("hex");
    await recordNewsletterPreference(tx, {
      personId,
      eventType: "opted_out",
      occurredAt: null,
      source: "Flodesk",
      sourceKey: `flodesk:unsubscribe-observation:${key}`,
      evidence:
        "Flodesk reports this address as unsubscribed. The original unsubscribe time and initiator are not supplied by the subscriber API.",
      metadata: {
        normalizedEmail: email.toLowerCase(),
        providerStatus: "unsubscribed",
      },
    });
    return true;
  });
}
