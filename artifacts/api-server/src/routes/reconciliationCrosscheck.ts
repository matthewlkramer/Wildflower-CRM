import { Router, type IRouter } from "express";
import { GetReconciliationCrosscheckQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { asyncHandler, parseOrBadRequest, parsePagination } from "../lib/helpers";
import {
  runReconciliationCrosscheck,
  type ClassifiedCrosscheckRow,
} from "../lib/reconciliationCrosscheck";

// Historical Transaction Reconciliation Cross-Check — admin-only, STRICTLY
// READ-ONLY. Parses three historical transaction spreadsheet exports (baked into
// a generated data module) and classifies every row against the CRM's
// already-synced Stripe charges / staged payments / gifts as matched /
// amount_mismatch / missing. This route never writes — it mints no gifts, stages
// no payments, and modifies no charge/payout. It only reports gaps so the
// fundraising team can see where the historical sheets and the CRM disagree.

const router: IRouter = Router();
router.use(requireAuth);

function matchesSearch(row: ClassifiedCrosscheckRow, q: string): boolean {
  const hay = [row.donorName, row.donorEmail, row.stripeChargeId]
    .filter((v): v is string => !!v)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

router.get(
  "/reconciliation-crosscheck",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const query = parseOrBadRequest(
      GetReconciliationCrosscheckQueryParams,
      req.query,
      res,
    );
    if (!query) return;

    const result = await runReconciliationCrosscheck();

    // Filters apply only to the row list; the summary + gaps describe the FULL
    // dataset so the aggregate gap picture is never distorted by a filter.
    const search = query.search?.trim().toLowerCase() ?? "";
    const filtered = result.rows.filter((row) => {
      if (query.source && row.source !== query.source) return false;
      if (query.classification && row.classification !== query.classification)
        return false;
      if (search && !matchesSearch(row, search)) return false;
      return true;
    });

    const { limit, page, offset } = parsePagination(query);
    const data = filtered.slice(offset, offset + limit);

    res.json({
      data,
      pagination: { page, limit, total: filtered.length },
      bySource: result.bySource,
      gaps: result.gaps,
    });
  }),
);

export default router;
