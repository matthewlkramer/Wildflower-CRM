import { writeFileSync } from "node:fs";
import { newsletterEvidenceSql } from "../lib/newsletterEvidenceSql";
/** Read sources and preview by default. --apply writes only evidence to the CRM;
 * never sends email, subscribes anyone in Flodesk, or creates new people.
 * Use --production to explicitly select PROD_DATABASE_URL (see runbook). */
if (process.argv.includes("--production")) {
  if (!process.env.PROD_DATABASE_URL)
    throw new Error("PROD_DATABASE_URL is required for --production");
  process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
}
const { db, pool } = await import("@workspace/db");
const { emails, people, newsletterPreferenceEvents } =
  await import("@workspace/db/schema");
const { eq, isNull } = await import("drizzle-orm");
const { listAllRecords } = await import("../lib/airtableClient");
const { listSubscribers } = await import("../lib/flodeskClient");
const { recordNewsletterPreference } =
  await import("../lib/newsletterPreferences");
const {
  filloutConsentEvidence,
  flodeskConsentEvidence,
  sourceText,
  SSJ_CONSENT_FIELDS,
  RAW_CONSENT_FIELDS,
} = await import("../lib/newsletterConsentSources");
type Evidence = import("../lib/newsletterConsentSources").ConsentEvidence;

async function main() {
  const apply = process.argv.includes("--apply");
  const sqlIndex = process.argv.indexOf("--sql-output");
  const sqlOutput = sqlIndex < 0 ? null : process.argv[sqlIndex + 1];
  if (sqlIndex >= 0 && (!sqlOutput || sqlOutput.startsWith("--")))
    throw new Error("--sql-output requires a file path");
  if (apply && sqlOutput)
    throw new Error("Choose --apply or --sql-output, not both");
  const [normalized, raw, identities, existing] = await Promise.all([
    listAllRecords({
      baseId: "appJBT9a4f3b7hWQ2",
      tableId: "tblvgyMdMcidh8k6u",
      fields: SSJ_CONSENT_FIELDS,
    }),
    listAllRecords({
      baseId: "appJBT9a4f3b7hWQ2",
      tableId: "tbls7U2BOBRQrfQTy",
      fields: RAW_CONSENT_FIELDS,
    }),
    db
      .select({ email: emails.email, personId: people.id })
      .from(emails)
      .innerJoin(people, eq(people.id, emails.personId))
      .where(isNull(people.archivedAt)),
    db.select().from(newsletterPreferenceEvents),
  ]);
  const candidates: Evidence[] = [];
  const issues: Array<{ sourceKey: string; reason: string }> = [];
  const represented = new Set(
    normalized
      .map((record) => sourceText(record.fields["Fillout Submission ID"]))
      .filter(Boolean),
  );
  for (const [records, isNormalized] of [
    [normalized, true],
    [raw, false],
  ] as const) {
    for (const record of records) {
      // The normalized source (including a test/review disposition) wins over its raw duplicate.
      if (
        !isNormalized &&
        represented.has(sourceText(record.fields["Submission ID"]))
      )
        continue;
      const event = filloutConsentEvidence(record, isNormalized);
      if (event) candidates.push(event);
      else
        issues.push({
          sourceKey: `airtable:${record.id}`,
          reason:
            "No verified consent/decline response, excluded disposition, or conflicting source values",
        });
    }
  }
  let reachedEnd = false;
  for (let page = 1; page <= 1000; page++) {
    // Read the whole audience so unsubscribed people outside the active segment are included.
    const result = await listSubscribers({ page, perPage: 100 });
    for (const subscriber of result.subscribers)
      candidates.push(...flodeskConsentEvidence(subscriber));
    if (
      result.subscribers.length < 100 ||
      (result.totalPages != null && page >= result.totalPages)
    ) {
      reachedEnd = true;
      break;
    }
  }
  if (!reachedEnd)
    throw new Error("Flodesk pagination did not finish; no backfill applied.");
  const peopleByEmail = new Map<string, Set<string>>();
  for (const identity of identities) {
    const email = identity.email.trim().toLowerCase();
    const ids = peopleByEmail.get(email) ?? new Set<string>();
    ids.add(identity.personId);
    peopleByEmail.set(email, ids);
  }
  const existingByKey = new Map(
    existing.map((event) => [event.sourceKey, event]),
  );
  const planned = new Map<string, Evidence & { personId: string }>();
  let unchanged = 0;
  const conflictedKeys = new Set<string>();
  for (const candidate of candidates) {
    if (conflictedKeys.has(candidate.sourceKey)) continue;
    const ids = [...(peopleByEmail.get(candidate.email) ?? [])];
    if (ids.length !== 1) {
      issues.push({
        sourceKey: candidate.sourceKey,
        reason: "No unique active CRM person for source email",
      });
      continue;
    }
    const previous =
      existingByKey.get(candidate.sourceKey) ??
      planned.get(candidate.sourceKey);
    if (previous) {
      if (
        previous.personId !== ids[0] ||
        previous.eventType !== candidate.eventType ||
        (previous.occurredAt?.toISOString() ?? null) !==
          (candidate.occurredAt?.toISOString() ?? null)
      ) {
        issues.push({
          sourceKey: candidate.sourceKey,
          reason:
            "Source identity, answer, or date conflicts with an existing event",
        });
        planned.delete(candidate.sourceKey);
        conflictedKeys.add(candidate.sourceKey);
      } else unchanged += 1;
      continue;
    }
    planned.set(candidate.sourceKey, { ...candidate, personId: ids[0]! });
  }
  if (sqlOutput) {
    const sql = newsletterEvidenceSql([...planned.values()]);
    writeFileSync(sqlOutput, sql, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
  if (apply) {
    // One transaction: a failed record cannot leave an undocumented partial import.
    await db.transaction(async (tx) => {
      for (const candidate of [...planned.values()].sort(
        (a, b) =>
          a.personId.localeCompare(b.personId) ||
          a.sourceKey.localeCompare(b.sourceKey),
      )) {
        const { email: _email, ...event } = candidate;
        await recordNewsletterPreference(tx, event);
      }
    });
  }
  console.log(
    JSON.stringify(
      {
        mode: apply ? "applied" : sqlOutput ? "sql-exported" : "preview",
        verifiedEvents: candidates.length,
        newEvents: planned.size,
        alreadyRecorded: unchanged,
        reviewCount: issues.length,
        undatedEvents: [...planned.values()].filter(
          (event) => !event.occurredAt,
        ).length,
        byType: [...planned.values()].reduce(
          (counts, event) => ({
            ...counts,
            [event.eventType]: (counts[event.eventType] ?? 0) + 1,
          }),
          {} as Record<string, number>,
        ),
        reviewItems: issues,
      },
      null,
      2,
    ),
  );
}
try {
  await main();
} finally {
  await pool.end();
}
