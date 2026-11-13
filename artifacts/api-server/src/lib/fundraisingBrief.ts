import { db } from "@workspace/db";
import {
  funderFindings,
  funderScanState,
  fundraisingFindingReviews,
  grantLeads,
  mediaMentions,
  organizations,
  users,
} from "@workspace/db/schema";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { chicagoToday } from "./effectiveProjectedCloseDate";
import { loadFunderTargets, shiftDate } from "./funderCadence";
import { deadlineHasPassed } from "./intelDetectors";

export type FindingKind = typeof fundraisingFindingReviews.$inferSelect.kind;
type FindingReview =
  | typeof fundraisingFindingReviews.$inferSelect.review
  | "unreviewed";

const publicFields = {
  id: mediaMentions.id,
  title: mediaMentions.title,
  url: mediaMentions.url,
  publicationName: mediaMentions.publicationName,
  publishedAt: mediaMentions.publicationDate,
  organizationId: funderFindings.organizationId,
  organizationName: organizations.name,
  category: funderFindings.category,
  summary: funderFindings.summary,
  deadline: funderFindings.deadline,
  official: funderFindings.officialSource,
  grantLeadId: funderFindings.grantLeadId,
  discoveredAt: funderFindings.discoveredAt,
  review: fundraisingFindingReviews.review,
  ownerName: sql<
    string | null
  >`NULLIF(CONCAT_WS(' ', ${users.firstName}, ${users.lastName}), '')`,
};

const grantFields = {
  id: grantLeads.id,
  title: grantLeads.title,
  url: grantLeads.url,
  deadline: grantLeads.deadline,
  summary: grantLeads.aiSummary,
  organizationId: grantLeads.targetOrganizationId,
  organizationName: sql<
    string | null
  >`CASE WHEN ${organizations.anonymous} THEN NULL ELSE COALESCE(${organizations.name}, ${grantLeads.funderName}) END`,
  discoveredAt: grantLeads.createdAt,
  review: fundraisingFindingReviews.review,
  ownerName: sql<
    string | null
  >`NULLIF(CONCAT_WS(' ', ${users.firstName}, ${users.lastName}), '')`,
};

function publicFindings() {
  return db
    .select(publicFields)
    .from(funderFindings)
    .innerJoin(
      mediaMentions,
      eq(mediaMentions.id, funderFindings.mediaMentionId),
    )
    .innerJoin(
      organizations,
      eq(organizations.id, funderFindings.organizationId),
    )
    .leftJoin(
      users,
      and(eq(users.id, organizations.ownerUserId), isNull(users.archivedAt)),
    )
    .leftJoin(
      fundraisingFindingReviews,
      and(
        eq(fundraisingFindingReviews.kind, "media"),
        eq(fundraisingFindingReviews.findingId, mediaMentions.id),
      ),
    );
}

function sharedGrantLeads() {
  return db
    .select(grantFields)
    .from(grantLeads)
    .leftJoin(
      organizations,
      eq(organizations.id, grantLeads.targetOrganizationId),
    )
    .leftJoin(
      users,
      and(
        eq(
          users.id,
          sql`COALESCE(${grantLeads.assigneeUserId}, ${organizations.ownerUserId})`,
        ),
        isNull(users.archivedAt),
      ),
    )
    .leftJoin(
      fundraisingFindingReviews,
      and(
        eq(fundraisingFindingReviews.kind, "grant_lead"),
        eq(fundraisingFindingReviews.findingId, grantLeads.id),
      ),
    );
}

const publicVisible = and(
  eq(mediaMentions.dismissed, false),
  eq(organizations.anonymous, false),
  isNull(organizations.archivedAt),
);
const grantVisible = and(
  inArray(grantLeads.status, ["new", "claimed"]),
  isNull(organizations.archivedAt),
  sql`${organizations.anonymous} IS DISTINCT FROM true`,
);

export async function resolveFundraisingFinding(kind: FindingKind, id: string) {
  if (kind === "media") {
    const [row] = await publicFindings().where(
      and(publicVisible, eq(mediaMentions.id, id)),
    );
    return row ?? null;
  }
  const [row] = await sharedGrantLeads().where(
    and(grantVisible, eq(grantLeads.id, id)),
  );
  return row ?? null;
}

export async function loadFundraisingBrief(all: boolean, now = new Date()) {
  const today = chicagoToday(now);
  const since = new Date(now.valueOf() - (all ? 90 : 7) * 86_400_000);
  const [articles, grants, targets, states] = await Promise.all([
    publicFindings()
      .where(and(publicVisible, gte(funderFindings.discoveredAt, since)))
      .orderBy(desc(funderFindings.discoveredAt)),
    sharedGrantLeads()
      .where(
        and(
          grantVisible,
          or(
            gte(grantLeads.createdAt, since),
            sql`EXISTS (SELECT 1 FROM funder_findings f WHERE f.grant_lead_id = ${grantLeads.id} AND f.discovered_at >= ${since.toISOString()}::timestamptz)`,
          ),
        ),
      )
      .orderBy(desc(grantLeads.createdAt)),
    loadFunderTargets(now),
    all ? db.select().from(funderScanState) : [],
  ]);
  const publicByGrant = new Map<string, (typeof articles)[number]>();
  for (const row of articles) {
    if (row.grantLeadId && !publicByGrant.has(row.grantLeadId))
      publicByGrant.set(row.grantLeadId, row);
  }
  const grantsById = new Set(grants.map((row) => row.id));
  const findings = [
    ...articles
      .filter((row) => !row.grantLeadId || !grantsById.has(row.grantLeadId))
      .map((row) => ({
        id: row.id,
        kind: "media" as const,
        title: row.title ?? row.publicationName,
        category: row.category,
        summary: row.summary,
        url: row.url,
        source: row.publicationName,
        publishedAt: row.publishedAt,
        deadline: row.deadline,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        ownerName: row.ownerName,
        review: (row.review ?? "unreviewed") as FindingReview,
        reason:
          row.category === "funding_opportunity"
            ? "Public application announcement"
            : row.category === "strategy_priorities"
              ? "A change that may affect funding fit"
              : row.category === "leadership_staff"
                ? "Review a potential contact or staff change"
                : "Recent coverage of this funder",
        rank:
          (row.category === "funding_opportunity"
            ? 30
            : row.category === "strategy_priorities"
              ? 20
              : row.category === "leadership_staff"
                ? 18
                : 5) + (row.official ? 3 : 0),
        discoveredAt: row.discoveredAt,
      })),
    ...grants.map((row) => {
      const publicSource = publicByGrant.get(row.id);
      return {
        id: row.id,
        kind: "grant_lead" as const,
        title: row.title,
        category: "funding_opportunity" as const,
        summary: publicSource?.summary ?? row.summary,
        url: publicSource?.url ?? null,
        source: publicSource?.publicationName ?? "Email Intelligence",
        publishedAt: publicSource?.publishedAt ?? null,
        deadline: row.deadline,
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        ownerName: row.ownerName,
        review: (row.review ??
          publicSource?.review ??
          "unreviewed") as FindingReview,
        reason: row.deadline
          ? "Review the application deadline and fit"
          : "Review eligibility and fit",
        rank: 30 + (publicSource?.official ? 3 : 0),
        discoveredAt: publicSource?.discoveredAt ?? row.discoveredAt,
      };
    }),
  ];
  const context = new Map(targets.map((target) => [target.id, target]));
  function score(item: (typeof findings)[number]) {
    const relationship = item.organizationId
      ? context.get(item.organizationId)
      : undefined;
    const deadline = item.deadline;
    const urgency =
      deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) && deadline >= today
        ? deadline <= shiftDate(today, 14)
          ? 12
          : deadline <= shiftDate(today, 45)
            ? 6
            : 0
        : 0;
    return (
      item.rank +
      (relationship?.priority ?? 0) +
      (relationship?.alignment === "high" ? 3 : 0) +
      urgency +
      (item.review === "useful" ? 4 : 0)
    );
  }
  const ranked = findings
    .filter(
      (item) =>
        all ||
        (item.review !== "dismissed" &&
          !deadlineHasPassed(item.deadline, now) &&
          (item.kind === "grant_lead" ||
            item.category !== "funding_opportunity")),
    )
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        b.discoveredAt.valueOf() - a.discoveredAt.valueOf(),
    );
  return {
    findings: (all ? ranked : ranked.slice(0, 5)).map(
      ({ rank, discoveredAt, ...item }) => item,
    ),
    coverage: all ? await loadCoverage(targets, states) : [],
  };
}

async function loadCoverage(
  scheduled: Awaited<ReturnType<typeof loadFunderTargets>>,
  states: (typeof funderScanState.$inferSelect)[],
) {
  const scheduledIds = new Set(scheduled.map((target) => target.id));
  const otherIds = states
    .filter((row) => !scheduledIds.has(row.organizationId))
    .map((row) => row.organizationId);
  const other = otherIds.length
    ? await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(
          and(
            inArray(organizations.id, otherIds),
            isNull(organizations.archivedAt),
            eq(organizations.anonymous, false),
            sql`${organizations.activeStatus} IS DISTINCT FROM 'defunct'`,
          ),
        )
        .orderBy(organizations.name)
    : [];
  const targets = [
    ...scheduled,
    ...other.map((org) => ({
      ...org,
      cadence: "as_needed" as const,
      reason: "No recurring check scheduled",
    })),
  ];
  const stateById = new Map(
    states.map((state) => [state.organizationId, state]),
  );
  return targets.map((target) => {
    const state = stateById.get(target.id);
    return {
      organizationId: target.id,
      organizationName: target.name,
      cadence: target.cadence,
      reason: target.reason,
      status: state?.requestedAt ? "pending" : (state?.status ?? "pending"),
      lastCheckedAt: state?.lastCheckedAt?.toISOString() ?? null,
      lastAttemptAt: state?.lastAttemptAt?.toISOString() ?? null,
      findingCount: state?.findingCount ?? 0,
    };
  });
}
