import { db } from "@workspace/db";
import { grantLeads } from "@workspace/db/schema";
import { and, asc, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { logger } from "./logger";
import {
  GRANT_LEAD_SUMMARY_PROVENANCE,
  summarizeGrantLeadById,
} from "./summarizeGrantLead";

const INTERVAL_MS = 15 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const BATCH_SIZE = 10;

async function summarizePendingGrantLeads(): Promise<void> {
  const retryBefore = new Date(Date.now() - RETRY_AFTER_MS);
  const rows = await db
    .select({ id: grantLeads.id })
    .from(grantLeads)
    .where(
      and(
        inArray(grantLeads.status, ["new", "claimed"]),
        or(
          and(
            isNull(grantLeads.aiSummary),
            or(
              isNull(grantLeads.aiSummarizedAt),
              lt(grantLeads.aiSummarizedAt, retryBefore),
            ),
          ),
          and(
            isNotNull(grantLeads.aiSummary),
            or(
              isNull(grantLeads.aiModel),
              ne(grantLeads.aiModel, GRANT_LEAD_SUMMARY_PROVENANCE),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(grantLeads.createdAt))
    .limit(BATCH_SIZE);

  if (rows.length === 0) return;
  const results = await Promise.allSettled(
    rows.map((row) => summarizeGrantLeadById(row.id)),
  );
  const completed = results.filter(
    (result) => result.status === "fulfilled" && result.value,
  ).length;
  logger.info(
    { attempted: rows.length, completed },
    "Grant-lead AI headline sweep complete",
  );
}

export function startGrantLeadSummaryScheduler(): void {
  const run = () => {
    void summarizePendingGrantLeads().catch((err) =>
      logger.error({ err }, "Grant-lead AI headline sweep failed"),
    );
  };
  setTimeout(run, 5_000);
  setInterval(run, INTERVAL_MS);
  logger.info("Grant-lead AI headline scheduler started");
}
