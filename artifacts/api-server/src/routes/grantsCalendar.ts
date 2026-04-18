import { Router } from "express";
import { db } from "@workspace/db";
import { opportunities, individuals, households, fundingEntities, users } from "@workspace/db/schema";
import { eq, and, gte, lte, or, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    const { from, to, fund } = req.query as Record<string, string>;

    const conditions: any[] = [
      sql`stage NOT IN ('declined', 'withdrawn', 'funded')`,
      or(
        sql`loi_deadline IS NOT NULL`,
        sql`proposal_deadline IS NOT NULL`,
        sql`decision_expected_date IS NOT NULL`,
      ),
    ];
    if (fund) conditions.push(eq(opportunities.fund, fund as any));
    if (from) {
      const fromDate = new Date(from);
      conditions.push(
        or(
          gte(opportunities.loiDeadline, fromDate),
          gte(opportunities.proposalDeadline, fromDate),
          gte(opportunities.decisionExpectedDate, fromDate),
        ),
      );
    }
    if (to) {
      const toDate = new Date(to);
      conditions.push(
        or(
          lte(opportunities.loiDeadline, toDate),
          lte(opportunities.proposalDeadline, toDate),
          lte(opportunities.decisionExpectedDate, toDate),
        ),
      );
    }

    const rows = await db
      .select({
        opp: opportunities,
        ownerName: users.displayName,
        individualFirstName: individuals.firstName,
        individualLastName: individuals.lastName,
        householdName: households.name,
        entityName: fundingEntities.legalName,
      })
      .from(opportunities)
      .leftJoin(users, eq(opportunities.ownerUserId, users.id))
      .leftJoin(individuals, eq(opportunities.individualId, individuals.id))
      .leftJoin(households, eq(opportunities.householdId, households.id))
      .leftJoin(fundingEntities, eq(opportunities.fundingEntityId, fundingEntities.id))
      .where(and(...conditions))
      .orderBy(opportunities.proposalDeadline, opportunities.loiDeadline);

    const now = new Date();

    const entries = rows.map((r) => {
      const opp = r.opp;

      const donorName = r.individualFirstName
        ? `${r.individualFirstName} ${r.individualLastName}`
        : r.householdName ?? r.entityName ?? "Unknown";

      const loiDeadline = opp.loiDeadline ? opp.loiDeadline.toISOString() : null;
      const proposalDeadline = opp.proposalDeadline ? opp.proposalDeadline.toISOString() : null;
      const decisionExpectedDate = opp.decisionExpectedDate
        ? opp.decisionExpectedDate.toISOString()
        : null;

      const upcomingDates = [opp.loiDeadline, opp.proposalDeadline]
        .filter((d): d is Date => d != null && d > now)
        .sort((a, b) => a.getTime() - b.getTime());

      const nextDeadlineDate = upcomingDates[0] ?? null;
      const nextDeadline = nextDeadlineDate ? nextDeadlineDate.toISOString() : null;
      const daysUntilNextDeadline = nextDeadlineDate
        ? Math.ceil((nextDeadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        opportunityId: opp.id,
        opportunityName: opp.name ?? null,
        donorName,
        fund: opp.fund,
        ownerName: r.ownerName ?? null,
        stage: opp.stage ?? undefined,
        governmentStage: opp.governmentStage ?? null,
        loiDeadline,
        loiSubmitted: opp.loiSubmitted ?? false,
        proposalDeadline,
        proposalSubmitted: opp.proposalSubmitted ?? false,
        decisionExpectedDate,
        amountRequested: opp.amountExpected ? Number(opp.amountExpected) : null,
        nextDeadline,
        daysUntilNextDeadline,
      };
    });

    res.json(entries);
  } catch (err) {
    next(err);
  }
});

export default router;
