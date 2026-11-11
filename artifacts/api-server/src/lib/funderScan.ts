import { db, pool } from "@workspace/db";
import {
  funderFindings,
  funderScanState,
  grantLeadSuppressions,
  organizations,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  cadenceDays,
  loadFunderTargets,
  shiftDate,
  type FunderTarget,
} from "./funderCadence";
import { chicagoToday } from "./effectiveProjectedCloseDate";
import {
  buildGrantLeadDedupeKey,
  extractNamedGrantProgram,
  normalizeGrantLeadIdentity,
} from "./grantLeadIdentity";
import {
  researchPublicFunder,
  type PublicFunderFinding,
} from "./funderPublicResearch";
import { upsertArticleWithId } from "./mediaIngest";
import { newId } from "./helpers";
import { logger } from "./logger";
import type { Tx } from "./reconciliationCommit";

type ScanState = typeof funderScanState.$inferSelect;
const DAY = 86_400_000;
const SCAN_LOCK = [9001, 2];

export function isFunderScanDue(
  cadence: FunderTarget["cadence"],
  state: ScanState | undefined,
  now: Date,
): boolean {
  if (state?.requestedAt)
    return (
      !state.lastAttemptAt ||
      now.valueOf() - (state.lastAttemptAt?.valueOf() ?? 0) >= 60 * 60_000
    );
  if (cadence === "as_needed") return false;
  if (!state) return true;
  if (state.status === "failed" || state.status === "partial") {
    return now.valueOf() - (state.lastAttemptAt?.valueOf() ?? 0) >= DAY;
  }
  return (
    !state.lastCheckedAt ||
    chicagoToday(state.lastCheckedAt) <=
      shiftDate(chicagoToday(now), -cadenceDays[cadence])
  );
}

async function attachGrantLead(
  tx: Tx,
  target: FunderTarget,
  finding: PublicFunderFinding,
): Promise<string | null> {
  if (finding.category !== "funding_opportunity") return null;
  const opportunity = {
    title: finding.article.title,
    funderName: target.searchName,
    deadline: finding.deadline,
    amount: null,
    url: finding.article.url,
    snippet: finding.summary ?? "",
  };
  const program = extractNamedGrantProgram(
    opportunity.title + "\n" + opportunity.snippet,
  );
  const suppressed = await tx
    .select({ id: grantLeadSuppressions.id })
    .from(grantLeadSuppressions)
    .where(
      or(
        and(
          eq(grantLeadSuppressions.scope, "funder"),
          inArray(grantLeadSuppressions.normalizedValue, [
            ...new Set(
              [target.name, target.searchName].map(normalizeGrantLeadIdentity),
            ),
          ]),
        ),
        program
          ? and(
              eq(grantLeadSuppressions.scope, "program"),
              eq(
                grantLeadSuppressions.normalizedValue,
                normalizeGrantLeadIdentity(program),
              ),
            )
          : undefined,
      ),
    )
    .limit(1);
  if (suppressed.length) return null;
  const dedupeKey = buildGrantLeadDedupeKey(opportunity, null);
  const now = new Date();
  const result = await tx.execute<{ id: string }>(sql`
    INSERT INTO grant_leads
      (id, dedupe_key, status, title, funder_name, target_organization_id, deadline, url, snippet, payload, created_at, updated_at)
    VALUES
      (${newId()}, ${dedupeKey}, 'new', ${opportunity.title}, ${target.name}, ${target.id}, ${finding.deadline},
       ${opportunity.url}, ${opportunity.snippet || null}, ${JSON.stringify(opportunity)}::jsonb, ${now}, ${now})
    ON CONFLICT (dedupe_key) WHERE status NOT IN ('archived', 'converted')
    DO UPDATE SET
      target_organization_id = COALESCE(grant_leads.target_organization_id, EXCLUDED.target_organization_id),
      deadline = COALESCE(grant_leads.deadline, EXCLUDED.deadline)
    RETURNING id
  `);
  return result.rows[0]?.id ?? null;
}

async function saveFinding(
  tx: Tx,
  target: FunderTarget,
  finding: PublicFunderFinding,
): Promise<boolean> {
  const { id } = await upsertArticleWithId(
    { kind: "organization", id: target.id, name: target.searchName },
    { ...finding.article, snippet: finding.summary ?? undefined },
    "funder_scan",
    tx,
  );
  if (!id) return false;
  const [existing] = await tx
    .select()
    .from(funderFindings)
    .where(eq(funderFindings.mediaMentionId, id));
  if (existing) return false;
  const grantLeadId = await attachGrantLead(tx, target, finding);
  const inserted = await tx
    .insert(funderFindings)
    .values({
      mediaMentionId: id,
      organizationId: target.id,
      grantLeadId,
      category: finding.category,
      summary: finding.summary,
      deadline: finding.deadline,
      officialSource: finding.official,
    })
    .onConflictDoNothing()
    .returning({ id: funderFindings.mediaMentionId });
  return inserted.length > 0;
}

async function storeScan(
  target: FunderTarget,
  previous: ScanState | undefined,
  now: Date,
  research: Awaited<ReturnType<typeof researchPublicFunder>> | null,
) {
  await db.transaction(async (tx) => {
    // Research finishes before locking. A merge or archive during the
    // network request can remove the target before anything is persisted.
    const [active] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, target.id),
          isNull(organizations.archivedAt),
          eq(organizations.anonymous, false),
          sql`${organizations.activeStatus} IS DISTINCT FROM 'defunct'`,
        ),
      )
      .for("share");
    if (!active) return;

    let count = 0;
    for (const finding of research?.findings ?? []) {
      if (await saveFinding(tx, target, finding)) count++;
    }
    let status: ScanState["status"] = "failed";
    if (research)
      status = research.complete
        ? count > 0
          ? "updates"
          : "no_updates"
        : "partial";
    const values = {
      lastAttemptAt: now,
      lastCheckedAt: research?.complete
        ? now
        : (previous?.lastCheckedAt ?? null),
      status,
      findingCount: count,
    };
    await tx
      .insert(funderScanState)
      .values({ organizationId: target.id, ...values })
      .onConflictDoUpdate({
        target: funderScanState.organizationId,
        set: {
          ...values,
          requestedAt: sql`CASE WHEN ${funderScanState.requestedAt} <= ${now.toISOString()}::timestamptz THEN NULL ELSE ${funderScanState.requestedAt} END`,
        },
      });
  });
}

async function scanFunder(
  target: FunderTarget,
  previous: ScanState | undefined,
  now: Date,
  researchFunder: typeof researchPublicFunder,
) {
  const today = chicagoToday(now);
  const since = previous?.lastCheckedAt
    ? [chicagoToday(previous.lastCheckedAt), shiftDate(today, -60)].sort()[1]!
    : shiftDate(today, -cadenceDays[target.cadence]);
  try {
    const research = await researchFunder(target, since, today);
    await storeScan(target, previous, now, research);
  } catch (error) {
    logger.warn(
      { err: error, organizationId: target.id },
      "Funder scan failed",
    );
    await storeScan(target, previous, now, null);
  }
}

export async function runDueFunderScans(
  now = new Date(),
  limit = 8,
  researchFunder = researchPublicFunder,
): Promise<number> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
      SCAN_LOCK,
    );
    locked = result.rows[0]?.locked === true;
    if (!locked) return 0;
    const states = await db.select().from(funderScanState);
    const targets = await loadFunderTargets(
      now,
      new Set(
        states
          .filter((row) => row.requestedAt)
          .map((row) => row.organizationId),
      ),
    );
    const byOrg = new Map(states.map((row) => [row.organizationId, row]));
    const due = targets.filter((target) =>
      isFunderScanDue(target.cadence, byOrg.get(target.id), now),
    );
    due.sort((a, b) => {
      const aAttempt = byOrg.get(a.id)?.lastAttemptAt?.valueOf() ?? 0;
      const bAttempt = byOrg.get(b.id)?.lastAttemptAt?.valueOf() ?? 0;
      return (
        Number(!!byOrg.get(b.id)?.requestedAt) -
          Number(!!byOrg.get(a.id)?.requestedAt) ||
        aAttempt - bAttempt ||
        b.priority - a.priority ||
        a.name.localeCompare(b.name)
      );
    });
    const batch = due.slice(0, limit);
    for (const target of batch)
      await scanFunder(target, byOrg.get(target.id), now, researchFunder);
    return batch.length;
  } finally {
    try {
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock($1::int, $2::int)",
          SCAN_LOCK,
        );
      client.release();
    } catch (error) {
      client.release(true);
      throw error;
    }
  }
}

export function startFunderScanScheduler() {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.DISABLE_SYNC_SCHEDULER === "1" ||
    process.env.DISABLE_MEDIA_INGEST === "1" ||
    process.env.DISABLE_FUNDER_SCAN === "1"
  )
    return;
  const tick = () => {
    void runDueFunderScans().catch((err) =>
      logger.error({ err }, "Funder scan scheduler failed"),
    );
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 15 * 60_000).unref();
}
