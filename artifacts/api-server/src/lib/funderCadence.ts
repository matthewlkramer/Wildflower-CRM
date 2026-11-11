import { db } from "@workspace/db";
import { organizations, users } from "@workspace/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  chicagoToday,
  effectiveProjectedCloseDate,
} from "./effectiveProjectedCloseDate";
import { fiscalYearSlugForDate } from "./giftAllocationSeed";
import { pledgeWrittenOffSumText } from "./pledgeCapacity";
import { foundationSearchName } from "./mediaIngest";

export const cadenceDays = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  as_needed: 7,
} as const;
export type ScanCadence = keyof typeof cadenceDays;
const DAY = 86_400_000;

export function shiftDate(day: string, days: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + days * DAY)
    .toISOString()
    .slice(0, 10);
}

export function developmentWeek(day: string): string {
  const weekday = new Date(day + "T00:00:00Z").getUTCDay();
  return shiftDate(day, -((weekday + 6) % 7));
}

export function creditedFiscalYears(today: string): string[] {
  const endingYear = Number(fiscalYearSlugForDate(today)?.slice(2));
  return Array.from({ length: 4 }, (_, age) => "fy" + (endingYear - age));
}

export function deriveFunderCadence(
  facts: {
    upcoming: boolean;
    open: boolean;
    outstanding: boolean;
    givingYears: string[];
  },
  fiscalYears: string[],
): { cadence: ScanCadence; reason: string; priority: number } | null {
  if (facts.upcoming)
    return {
      cadence: "weekly",
      reason: "Application or decision in the next 90 days",
      priority: 5,
    };
  if (facts.open)
    return { cadence: "weekly", reason: "Open opportunity", priority: 4 };
  if (facts.outstanding)
    return { cadence: "weekly", reason: "Outstanding pledge", priority: 3 };
  if (
    facts.givingYears.some((year) => fiscalYears.slice(0, 2).includes(year))
  ) {
    return {
      cadence: "biweekly",
      reason: "Giving or a commitment credited to this or last fiscal year",
      priority: 2,
    };
  }
  if (
    facts.givingYears.some((year) => fiscalYears.slice(2, 4).includes(year))
  ) {
    return {
      cadence: "monthly",
      reason: "Giving or a commitment credited two to three fiscal years ago",
      priority: 1,
    };
  }
  return null;
}

export async function loadFunderTargets(
  now = new Date(),
  includeIds: ReadonlySet<string> = new Set(),
) {
  const today = chicagoToday(now);
  const fiscalYears = creditedFiscalYears(today);
  const next90 = shiftDate(today, 90);
  const [orgs, opportunityResult, givingResult] = await Promise.all([
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        entityType: organizations.entityType,
        website: organizations.website,
        alignment: organizations.strategicAlignment,
        ownerName: sql<
          string | null
        >`NULLIF(CONCAT_WS(' ', ${users.firstName}, ${users.lastName}), '')`,
      })
      .from(organizations)
      .leftJoin(
        users,
        and(eq(users.id, organizations.ownerUserId), isNull(users.archivedAt)),
      )
      .where(
        and(
          isNull(organizations.archivedAt),
          eq(organizations.anonymous, false),
          sql`${organizations.activeStatus} IS DISTINCT FROM 'defunct'`,
        ),
      ),
    // Status is the CRM's persisted pledge lifecycle derivation. In
    // particular, fully paid and closed awards are terminal. A write-off
    // also ends monitoring when it extinguishes the remaining commitment.
    db.execute<{
      organization_id: string;
      status: string | null;
      application_deadline: string | null;
      projected_close_date: string | null;
      projected_close_months_out: number | null;
    }>(sql`
      SELECT organization_id, status, application_deadline::text,
             projected_close_date::text, projected_close_months_out
      FROM opportunities_and_pledges p
      WHERE archived_at IS NULL AND organization_id IS NOT NULL
        AND write_off_of_pledge_id IS NULL AND loan_or_grant = 'grant'
        AND (status IN ('open','pledge') OR status IS NULL)
        AND (status IS DISTINCT FROM 'pledge' OR NOT EXISTS (
          SELECT 1 FROM opportunities_and_pledges child
          WHERE child.write_off_of_pledge_id = p.id AND child.archived_at IS NULL
        ) OR COALESCE((SELECT SUM(a.sub_amount) FROM pledge_allocations a WHERE a.pledge_or_opportunity_id = p.id), 0)
          + ${sql.raw(pledgeWrittenOffSumText("p"))} - p.paid > 0)
    `),
    db.execute<{ organization_id: string; grant_year: string }>(sql`
      SELECT g.organization_id, a.grant_year
      FROM gift_allocations a JOIN gifts_and_payments g ON g.id = a.gift_id
      WHERE a.grant_year IN (${sql.join(
        fiscalYears.map((year) => sql`${year}`),
        sql`, `,
      )})
        AND a.sub_amount > 0 AND g.amount > 0 AND g.archived_at IS NULL
        AND g.organization_id IS NOT NULL AND g.loan_or_grant = 'grant'
      UNION
      SELECT p.organization_id, a.grant_year
      FROM pledge_allocations a JOIN opportunities_and_pledges p ON p.id = a.pledge_or_opportunity_id
      WHERE a.grant_year IN (${sql.join(
        fiscalYears.map((year) => sql`${year}`),
        sql`, `,
      )})
        AND a.sub_amount > 0 AND p.archived_at IS NULL AND p.write_off_of_pledge_id IS NULL
        AND p.organization_id IS NOT NULL AND p.loan_or_grant = 'grant'
        AND p.status IN ('pledge','cash_in')
    `),
  ]);

  const facts = new Map<
    string,
    {
      upcoming: boolean;
      open: boolean;
      outstanding: boolean;
      givingYears: string[];
    }
  >();
  function forOrganization(id: string) {
    const previous = facts.get(id);
    if (previous) return previous;
    const initial = {
      upcoming: false,
      open: false,
      outstanding: false,
      givingYears: [] as string[],
    };
    facts.set(id, initial);
    return initial;
  }
  for (const row of opportunityResult.rows) {
    const signals = forOrganization(row.organization_id);
    if (row.status === "pledge") {
      signals.outstanding = true;
      continue;
    }
    signals.open = true;
    const decision = effectiveProjectedCloseDate(
      row.projected_close_date,
      row.projected_close_months_out,
      today,
    );
    signals.upcoming ||= [row.application_deadline, decision].some(
      (day) => day && day >= today && day <= next90,
    );
  }
  for (const row of givingResult.rows)
    forOrganization(row.organization_id).givingYears.push(row.grant_year);

  return orgs
    .flatMap((org) => {
      const signals = facts.get(org.id);
      const rule =
        (signals && deriveFunderCadence(signals, fiscalYears)) ??
        (includeIds.has(org.id)
          ? {
              cadence: "as_needed" as const,
              reason: "Requested by staff",
              priority: 0,
            }
          : null);
      if (!rule) return [];
      const name =
        org.entityType === "corporate_foundation" ||
        org.entityType === "bank_foundation"
          ? foundationSearchName(org.name)
          : org.name;
      return [{ ...org, ...rule, searchName: name }];
    })
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

export type FunderTarget = Awaited<
  ReturnType<typeof loadFunderTargets>
>[number];
