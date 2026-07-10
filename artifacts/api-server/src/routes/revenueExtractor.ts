import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getViewer } from "../lib/identityVisibility";
import { buildRevenueExtractorReport } from "../lib/revenueExtractor";

/**
 * Finance-facing Revenue Extractor report.
 *
 *   GET /revenue-extractor?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *
 * One row per gift allocation (plus a separate negative processor-fee line per
 * gift that carries fees) for all non-archived gifts whose date_received falls
 * in the inclusive range. Both dates are required and validated with a Date
 * round-trip (a syntactically-valid but nonsense date like 2026-13-40 that the
 * DB would reject with a 500 is caught here → 400).
 */
const router: IRouter = Router();
router.use(requireAuth);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

router.get(
  "/revenue-extractor",
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
      res.status(400).json({
        error: "bad_request",
        message: "startDate and endDate are required (YYYY-MM-DD).",
      });
      return;
    }
    if (startDate > endDate) {
      res.status(400).json({
        error: "bad_request",
        message: "startDate must be on or before endDate.",
      });
      return;
    }
    const report = await buildRevenueExtractorReport(
      startDate,
      endDate,
      getViewer(req),
    );
    res.json(report);
  }),
);

export default router;
