import { afterAll, beforeAll, expect, it } from "vitest";
import { db, pool } from "@workspace/db";
import {
  emails,
  newsletterPreferenceEvents,
  people,
} from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { newsletterEvidenceSql } from "../lib/newsletterEvidenceSql";

const id = `newsletter_sql_${Date.now()}`;
const evidence = {
  personId: id,
  email: `${id}@example.org`,
  eventType: "consent_given" as const,
  occurredAt: new Date("2020-01-01T12:00:00Z"),
  source: "Fillout",
  sourceKey: id,
  evidence: "Verified 'Yes' — original \\ response",
  metadata: { normalizedEmail: `${id}@example.org` },
};
beforeAll(async () => {
  await db.insert(people).values({ id, fullName: "SQL evidence fixture" });
  await db.insert(emails).values({ id, email: evidence.email, personId: id });
});
afterAll(async () => {
  await db
    .delete(newsletterPreferenceEvents)
    .where(eq(newsletterPreferenceEvents.personId, id));
  await db.delete(emails).where(eq(emails.id, id));
  await db.delete(people).where(eq(people.id, id));
});
async function apply(sql: string) {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
it("preserves literal source text, derives eligibility, and replays without duplication", async () => {
  const sql = newsletterEvidenceSql([evidence]);
  await apply(sql);
  await apply(sql);
  const events = await db
    .select()
    .from(newsletterPreferenceEvents)
    .where(eq(newsletterPreferenceEvents.personId, id));
  expect(events.length).toBe(1);
  expect(events[0].evidence).toBe(evidence.evidence);
  expect(
    (await db.select().from(people).where(eq(people.id, id)))[0].newsletter,
  ).toBe(true);
});
it("aborts on changed source evidence or identity drift, retaining the original history", async () => {
  await expect(
    apply(
      newsletterEvidenceSql([{ ...evidence, evidence: "Conflicting answer" }]),
    ),
  ).rejects.toThrow();
  await db
    .update(emails)
    .set({ email: `changed_${id}@example.org` })
    .where(eq(emails.id, id));
  await expect(
    apply(newsletterEvidenceSql([{ ...evidence, sourceKey: `${id}_new` }])),
  ).rejects.toThrow();
  expect(
    (
      await db
        .select()
        .from(newsletterPreferenceEvents)
        .where(eq(newsletterPreferenceEvents.personId, id))
    ).length,
  ).toBe(1);
});
