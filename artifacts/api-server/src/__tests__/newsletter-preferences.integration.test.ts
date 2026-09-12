import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@workspace/db";
import { newsletterPreferenceEvents, people } from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";
import { recordNewsletterPreference } from "../lib/newsletterPreferences";

const prefix = `newsletter_evidence_${Date.now()}`;
const ids = [prefix, `${prefix}_unknown`, `${prefix}_merge`];
beforeAll(async () => {
  await db.insert(people).values(ids.map((id) => ({ id, fullName: id })));
});
afterAll(async () => {
  await db
    .delete(newsletterPreferenceEvents)
    .where(inArray(newsletterPreferenceEvents.personId, ids));
  await db.delete(people).where(inArray(people.id, ids));
});
async function add(
  type: string,
  date: string | null,
  key: string,
  personId = prefix,
) {
  return db.transaction((tx) =>
    recordNewsletterPreference(tx, {
      personId,
      eventType: type,
      occurredAt: date ? new Date(date) : null,
      source: "Test source",
      sourceKey: `${prefix}:${key}`,
      evidence: `Evidence ${key}`,
    }),
  );
}
async function state(personId = prefix) {
  return db
    .select({
      selected: people.newsletter,
      optedOut: people.unsubscribedToNewsletter,
    })
    .from(people)
    .where(eq(people.id, personId))
    .then((r) => r[0]);
}
describe("newsletter evidence authority", () => {
  it("staff additions are eligible but cannot lift a subsequent opt-out", async () => {
    await add("staff_added", "2020-01-01T12:00:00Z", "added");
    expect(await state()).toEqual({ selected: true, optedOut: false });
    await add("opted_out", "2021-01-01T12:00:00Z", "optout");
    await add("staff_added", "2022-01-01T12:00:00Z", "readded");
    expect(await state()).toEqual({ selected: true, optedOut: true });
  });
  it("only later affirmative consent lifts the opt-out, preserving all evidence", async () => {
    await add("consent_given", "2020-06-01T12:00:00Z", "historicalconsent");
    expect((await state()).optedOut).toBe(true);
    await add("consent_given", "2021-01-01T12:00:00Z", "sametime");
    expect((await state()).optedOut).toBe(true);
    const event = await add("consent_given", "2023-01-01T12:00:00Z", "renewed");
    expect(await state()).toEqual({ selected: true, optedOut: false });
    expect(
      (await add("consent_given", "2023-01-01T12:00:00Z", "renewed")).id,
    ).toBe(event.id);
    await expect(
      add("staff_added", "2023-01-01T12:00:00Z", "renewed"),
    ).rejects.toThrow("conflicts");
  });
  it("staff removal changes membership without fabricating a donor opt-out", async () => {
    await add("staff_removed", "2024-01-01T12:00:00Z", "removed");
    expect(await state()).toEqual({ selected: false, optedOut: false });
  });
  it("unknown-date opt-out is not erased by old imported consent", async () => {
    await add("legacy_opted_out", null, "unknownoptout", ids[1]);
    await add("consent_given", "2020-01-01T12:00:00Z", "oldconsent", ids[1]);
    expect((await state(ids[1])).optedOut).toBe(true);
    await add("consent_given", null, "undatedconsent", ids[1]);
    expect((await state(ids[1])).optedOut).toBe(true);
  });
  it("moving evidence in a merge recomputes the surviving person's preference", async () => {
    await db
      .update(newsletterPreferenceEvents)
      .set({ personId: ids[2] })
      .where(eq(newsletterPreferenceEvents.personId, ids[1]));
    expect((await state(ids[2])).optedOut).toBe(true);
  });
});
