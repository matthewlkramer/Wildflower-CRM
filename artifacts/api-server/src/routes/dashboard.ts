import { Router } from "express";
import { db } from "@workspace/db";
import {
  opportunities,
  moves,
  individuals,
  households,
  fundingEntities,
  pledgeInstallments,
  pledges,
  gifts,
  users,
} from "@workspace/db/schema";
import { eq, and, lte, gte, desc, lt, sql, or, inArray, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import {
  currentFiscalYear,
  parseFiscalYear,
  type FiscalYear,
} from "../lib/helpers";

const router = Router();
router.use(requireAuth);

function fyBoundsForYear(year: number): { start: Date; end: Date } {
  return {
    start: new Date(`${year - 1}-07-01`),
    end: new Date(`${year}-06-30T23:59:59.999Z`),
  };
}

function fyBounds(fyLabel: FiscalYear): { start: Date; end: Date } {
  return fyBoundsForYear(Number(fyLabel.replace("FY", "")));
}

router.get("/summary", async (req, res, next) => {
  try {
    const fiscalYear: FiscalYear =
      req.query.fiscalYear !== undefined
        ? parseFiscalYear(req.query.fiscalYear)
        : currentFiscalYear();
    const { start, end } = fyBounds(fiscalYear);
    const { start: lastStart, end: lastEnd } = fyBoundsForYear(
      Number(fiscalYear.replace("FY", "")) - 1,
    );

    const now = new Date();
    const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const openStages = [
      "pre_conversation",
      "conversation",
      "solicitation",
      "negotiation",
      "committed",
    ] as const;

    const [
      oppsByFundRaw,
      overdueStepsResult,
      quietDonorsResult,
      upcomingDeadlinesResult,
      installmentsDueResult,
      givingCurrentFY,
      givingLastFY,
    ] = await Promise.all([
      db
        .select({
          fund: opportunities.fund,
          count: count(),
          value: sql<string>`coalesce(sum(amount_expected), 0)`,
        })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.fiscalYear, fiscalYear),
            inArray(opportunities.stage, [...openStages]),
          ),
        )
        .groupBy(opportunities.fund),

      db
        .select({ count: count() })
        .from(moves)
        .where(
          and(
            lt(moves.nextStepDueDate, now),
            sql`next_step IS NOT NULL`,
            sql`next_step_due_date IS NOT NULL`,
          ),
        ),

      db
        .select({ count: count() })
        .from(individuals)
        .where(
          and(
            sql`donor_cultivation_stage NOT IN ('pre_qualified', 'lapsed_relationship')`,
            or(
              lt(individuals.lastMoveDate, ninetyDaysAgo),
              sql`last_move_date IS NULL`,
            ),
          ),
        ),

      db
        .select({ count: count() })
        .from(opportunities)
        .where(
          and(
            or(
              and(
                sql`loi_deadline IS NOT NULL`,
                gte(opportunities.loiDeadline, now),
                lte(opportunities.loiDeadline, thirtyDaysOut),
              ),
              and(
                sql`proposal_deadline IS NOT NULL`,
                gte(opportunities.proposalDeadline, now),
                lte(opportunities.proposalDeadline, thirtyDaysOut),
              ),
            ),
          ),
        ),

      db
        .select({ count: count() })
        .from(pledgeInstallments)
        .leftJoin(pledges, eq(pledgeInstallments.pledgeId, pledges.id))
        .where(
          and(
            eq(pledgeInstallments.status, "scheduled"),
            gte(pledgeInstallments.dueDate, now),
            lte(pledgeInstallments.dueDate, thirtyDaysOut),
          ),
        ),

      db
        .select({ total: sql<string>`coalesce(sum(amount), 0)` })
        .from(gifts)
        .where(and(gte(gifts.cashReceivedDate, start), lte(gifts.cashReceivedDate, end))),

      db
        .select({ total: sql<string>`coalesce(sum(amount), 0)` })
        .from(gifts)
        .where(
          and(gte(gifts.cashReceivedDate, lastStart), lte(gifts.cashReceivedDate, lastEnd)),
        ),
    ]);

    res.json({
      openOpportunitiesCount: oppsByFundRaw.reduce((sum, r) => sum + r.count, 0),
      openOpportunitiesValue: oppsByFundRaw.reduce((sum, r) => sum + Number(r.value), 0),
      overdueNextStepsCount: overdueStepsResult[0]?.count ?? 0,
      donorsGoneQuietCount: quietDonorsResult[0]?.count ?? 0,
      upcomingDeadlinesCount: upcomingDeadlinesResult[0]?.count ?? 0,
      pledgeInstallmentsDueCount: installmentsDueResult[0]?.count ?? 0,
      totalGivingCurrentFY: Number(givingCurrentFY[0]?.total ?? 0),
      totalGivingLastFY: Number(givingLastFY[0]?.total ?? 0),
      opportunitiesByFund: oppsByFundRaw.map((r) => ({
        fund: r.fund,
        count: r.count,
        value: Number(r.value),
      })),
      recentActivity: [],
    });
  } catch (err) {
    next(err);
  }
});

router.get("/recent-activity", async (req, res, next) => {
  try {
    const { limit = "20" } = req.query as Record<string, string>;

    const rows = await db
      .select({
        move: moves,
        ownerName: users.displayName,
        ownerId: users.id,
        individualFirstName: individuals.firstName,
        individualLastName: individuals.lastName,
        householdName: households.name,
        entityName: fundingEntities.legalName,
      })
      .from(moves)
      .leftJoin(users, eq(moves.staffUserId, users.id))
      .leftJoin(individuals, eq(moves.individualId, individuals.id))
      .leftJoin(households, eq(moves.householdId, households.id))
      .leftJoin(fundingEntities, eq(moves.fundingEntityId, fundingEntities.id))
      .where(eq(moves.isDraft, false))
      .orderBy(desc(moves.date))
      .limit(Number(limit));

    const now = new Date();

    res.json(
      rows.map((r) => {
        const donorName = r.individualFirstName
          ? `${r.individualFirstName} ${r.individualLastName}`
          : r.householdName ?? r.entityName ?? "Unknown";
        const entityType = r.move.individualId
          ? "individual"
          : r.move.householdId
            ? "household"
            : "funding_entity";
        const entityId =
          r.move.individualId ?? r.move.householdId ?? r.move.fundingEntityId ?? "";

        return {
          id: r.move.id,
          type: "move" as const,
          entityType,
          entityId,
          entityName: donorName,
          description: r.move.subject ?? "",
          userId: r.move.staffUserId ?? "",
          userName: r.ownerName ?? "",
          timestamp: r.move.date?.toISOString() ?? now.toISOString(),
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/overdue-next-steps", async (req, res, next) => {
  try {
    const { limit = "20" } = req.query as Record<string, string>;
    const now = new Date();

    const rows = await db
      .select({
        move: moves,
        ownerName: users.displayName,
        individualFirstName: individuals.firstName,
        individualLastName: individuals.lastName,
        householdName: households.name,
        entityName: fundingEntities.legalName,
      })
      .from(moves)
      .leftJoin(users, eq(moves.staffUserId, users.id))
      .leftJoin(individuals, eq(moves.individualId, individuals.id))
      .leftJoin(households, eq(moves.householdId, households.id))
      .leftJoin(fundingEntities, eq(moves.fundingEntityId, fundingEntities.id))
      .where(and(lt(moves.nextStepDueDate, now), sql`next_step IS NOT NULL`))
      .orderBy(moves.nextStepDueDate)
      .limit(Number(limit));

    res.json(
      rows.map((r) => {
        const donorName = r.individualFirstName
          ? `${r.individualFirstName} ${r.individualLastName}`
          : r.householdName ?? r.entityName ?? "Unknown";
        const entityType = r.move.individualId
          ? "individual"
          : r.move.householdId
            ? "household"
            : "funding_entity";
        const entityId =
          r.move.individualId ?? r.move.householdId ?? r.move.fundingEntityId ?? "";
        const dueDate = r.move.nextStepDueDate;
        const daysOverdue = dueDate
          ? Math.ceil((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
          : 0;

        return {
          moveId: r.move.id,
          entityType,
          entityId,
          entityName: donorName,
          nextStep: r.move.nextStep ?? "",
          dueDate: dueDate?.toISOString() ?? now.toISOString(),
          daysOverdue,
          ownerName: r.ownerName ?? "",
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.get("/donors-gone-quiet", async (req, res, next) => {
  try {
    const { limit = "20" } = req.query as Record<string, string>;
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const rows = await db
      .select({
        ind: individuals,
        ownerName: users.displayName,
        openOppsCount: sql<number>`(
          SELECT count(*) FROM opportunities
          WHERE individual_id = ${individuals.id}
          AND stage NOT IN ('declined', 'withdrawn', 'funded')
        )`,
      })
      .from(individuals)
      .leftJoin(users, eq(individuals.relationshipOwnerUserId, users.id))
      .where(
        and(
          sql`donor_cultivation_stage NOT IN ('pre_qualified', 'lapsed_relationship')`,
          or(
            lt(individuals.lastMoveDate, ninetyDaysAgo),
            sql`last_move_date IS NULL`,
          ),
        ),
      )
      .orderBy(individuals.lastMoveDate)
      .limit(Number(limit));

    res.json(
      rows.map((r) => {
        const lastMoveDate = r.ind.lastMoveDate;
        const daysSinceLastMove = lastMoveDate
          ? Math.ceil((now.getTime() - lastMoveDate.getTime()) / (1000 * 60 * 60 * 24))
          : 9999;

        return {
          entityType: "individual" as const,
          entityId: r.ind.id,
          entityName: `${r.ind.firstName} ${r.ind.lastName}`,
          lastMoveDate: lastMoveDate?.toISOString() ?? null,
          daysSinceLastMove,
          cultivationStage: r.ind.donorCultivationStage ?? "",
          ownerName: r.ownerName ?? null,
          openOpportunitiesCount: Number(r.openOppsCount ?? 0),
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
