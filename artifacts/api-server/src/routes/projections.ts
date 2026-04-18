import { Router } from "express";
import { db } from "@workspace/db";
import { opportunities, pledgeInstallments, pledges } from "@workspace/db/schema";
import { eq, and, sql, gte, lte } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { currentFiscalYear } from "../lib/helpers";

const router = Router();
router.use(requireAuth);

const STAGE_PROBABILITY: Record<string, number> = {
  pre_conversation: 10,
  conversation: 20,
  solicitation: 40,
  negotiation: 60,
  committed: 85,
  funded: 100,
  stewarding: 100,
  declined: 0,
  withdrawn: 0,
};

const VERBALLY_COMMITTED_STAGES = new Set(["committed", "funded", "stewarding"]);
const CONFIRMED_STAGES = new Set(["funded", "stewarding"]);

function fyLabel(year: number): string {
  return `FY${year}`;
}

router.get("/forecast", async (req, res, next) => {
  try {
    const currentFY = currentFiscalYear();
    const currentYear = Number(currentFY.replace("FY", ""));

    const fiscalYearNumbers = [currentYear, currentYear + 1, currentYear + 2];

    const fyLabels = fiscalYearNumbers.map((y) => fyLabel(y));

    const allOpps = await db
      .select()
      .from(opportunities)
      .where(sql`fiscal_year IN (${fyLabels.map((fy) => `'${fy}'`).join(", ")})`);

    const allFunds = [...new Set(allOpps.map((o) => o.fund))] as string[];

    let totalConfirmed = 0;
    let totalWeightedPipeline = 0;
    let totalForecast = 0;

    const fiscalYears = fiscalYearNumbers.map((year) => {
      const label = fyLabel(year);
      const yearOpps = allOpps.filter((o) => o.fiscalYear === label);

      let confirmed = 0;
      let verballyCommitted = 0;
      let weightedPipeline = 0;
      let stretch = 0;

      const fundMap: Record<string, { confirmed: number; weightedPipeline: number; totalForecast: number }> = {};

      for (const opp of yearOpps) {
        const amount = Number(opp.amountExpected ?? 0);
        const baseProbability = STAGE_PROBABILITY[opp.stage] ?? 50;
        const probability = opp.probabilityOverridden
          ? (opp.probability ?? baseProbability)
          : baseProbability;

        if (CONFIRMED_STAGES.has(opp.stage)) {
          confirmed += amount;
        }
        if (VERBALLY_COMMITTED_STAGES.has(opp.stage)) {
          verballyCommitted += amount;
        }
        weightedPipeline += amount * (probability / 100);
        stretch += amount;

        if (!fundMap[opp.fund]) {
          fundMap[opp.fund] = { confirmed: 0, weightedPipeline: 0, totalForecast: 0 };
        }
        if (CONFIRMED_STAGES.has(opp.stage)) {
          fundMap[opp.fund].confirmed += amount;
        }
        fundMap[opp.fund].weightedPipeline += amount * (probability / 100);
        fundMap[opp.fund].totalForecast += amount * (probability / 100);
      }

      const fyConfirmed = confirmed;
      const fyWeighted = weightedPipeline;
      const fyForecast = weightedPipeline;

      totalConfirmed += fyConfirmed;
      totalWeightedPipeline += fyWeighted;
      totalForecast += fyForecast;

      const byFund = allFunds
        .filter((f) => fundMap[f])
        .map((fund) => ({
          fund: fund as any,
          confirmed: fundMap[fund]?.confirmed ?? 0,
          weightedPipeline: fundMap[fund]?.weightedPipeline ?? 0,
          totalForecast: fundMap[fund]?.totalForecast ?? 0,
        }));

      return {
        fiscalYear: year,
        label,
        confirmed: fyConfirmed,
        verballyCommitted,
        weightedPipeline: fyWeighted,
        stretch,
        totalForecast: fyForecast,
        target: null,
        gap: null,
        byFund,
      };
    });

    res.json({
      fiscalYears,
      totalConfirmed,
      totalWeightedPipeline,
      totalForecast,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/pledge-schedule", async (req, res, next) => {
  try {
    const { from, to, fund } = req.query as Record<string, string>;
    const conditions: any[] = [];
    if (from) conditions.push(gte(pledgeInstallments.dueDate, new Date(from)));
    if (to) conditions.push(lte(pledgeInstallments.dueDate, new Date(to)));
    if (fund) conditions.push(eq(pledges.fund, fund as any));

    const rows = await db
      .select({
        installment: pledgeInstallments,
        pledge: pledges,
      })
      .from(pledgeInstallments)
      .leftJoin(pledges, eq(pledgeInstallments.pledgeId, pledges.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(pledgeInstallments.dueDate);

    res.json(rows.map((r) => ({ ...r.installment, pledge: r.pledge })));
  } catch (err) {
    next(err);
  }
});

export default router;
