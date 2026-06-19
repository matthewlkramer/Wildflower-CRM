import { Router, type IRouter } from "express";
import { asyncHandler } from "../../lib/helpers";
import { logger } from "../../lib/logger";
import {
  syncQuickbooks,
  startFullResync,
  getFullResyncState,
  rematchStagedPayments,
  reclassifyStagedPayments,
} from "../../lib/quickbooksSync";
import { requireAdmin } from "./shared";

const router: IRouter = Router();

// ─── POST /quickbooks/sync ─────────────────────────────────────────────────
router.post(
  "/quickbooks/sync",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await syncQuickbooks();
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "QuickBooks manual sync failed");
      res.status(502).json({
        error: "sync_failed",
        message: e instanceof Error ? e.message : "QuickBooks sync failed",
      });
    }
  }),
);

// ─── POST /quickbooks/resync-full ──────────────────────────────────────────
// Admin-gated NON-destructive full re-pull. Ignores the watermark to re-fetch
// the entire QuickBooks back-catalog and re-enrich every existing staged row
// with the extended QB capture fields (payer type, raw JSON, etc.). Unlike the
// destructive cutover this preserves ALL review state — status, donor match,
// exclusion, grouping are never touched (the upsert refreshes only read-only QB
// facts). Use after deploying new capture fields to backfill existing rows.
router.post(
  "/quickbooks/resync-full",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    // Kick off the (multi-minute) re-pull in the background and return the
    // current state immediately — the browser/proxy would otherwise time out
    // long before the job finishes. The UI polls GET /quickbooks/resync-status.
    const state = startFullResync();
    req.log.info(
      { status: state.status },
      "QuickBooks full re-pull (background) requested",
    );
    res.json(state);
  }),
);

// ─── GET /quickbooks/resync-status ─────────────────────────────────────────
// Admin-gated progress for the background full re-pull started above.
router.get(
  "/quickbooks/resync-status",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json(getFullResyncState());
  }),
);

// ─── POST /quickbooks/rematch ──────────────────────────────────────────────
router.post(
  "/quickbooks/rematch",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await rematchStagedPayments();
      req.log.info(
        { ran: summary.ran, scanned: summary.scanned, matched: summary.matched },
        "QuickBooks staged-payment rematch run",
      );
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "QuickBooks rematch failed");
      res.status(502).json({
        error: "rematch_failed",
        message: e instanceof Error ? e.message : "QuickBooks rematch failed",
      });
    }
  }),
);

// ─── POST /quickbooks/reclassify ───────────────────────────────────────────
// Admin-gated: re-run the noise classifier over auto-classified pending/excluded
// rows so refined rules retroactively clean up (or restore) staged rows. Never
// touches a manual include/exclude.
router.post(
  "/quickbooks/reclassify",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const summary = await reclassifyStagedPayments();
      req.log.info(
        {
          ran: summary.ran,
          scanned: summary.scanned,
          excluded: summary.excluded,
          included: summary.included,
        },
        "QuickBooks staged-payment reclassify run",
      );
      res.json(summary);
    } catch (e) {
      logger.error({ err: e }, "QuickBooks reclassify failed");
      res.status(502).json({
        error: "reclassify_failed",
        message: e instanceof Error ? e.message : "QuickBooks reclassify failed",
      });
    }
  }),
);

export default router;
