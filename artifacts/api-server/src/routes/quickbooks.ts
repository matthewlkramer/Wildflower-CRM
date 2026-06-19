import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import queueRouter from "./quickbooks/queue";
import actionsRouter from "./quickbooks/actions";
import candidatesRouter from "./quickbooks/candidates";
import matchingRouter from "./quickbooks/matching";
import revertRouter from "./quickbooks/revert";
import syncRouter from "./quickbooks/sync";

/**
 * Review queue for QuickBooks-sourced payments plus the manual sync / rematch /
 * reclassify triggers. The queue is organized into three derived buckets:
 *
 *   Auto-matched : status='approved' AND autoApplied=true AND
 *                  matchConfirmedAt IS NULL — high-confidence matches the system
 *                  already applied (reconciled to an existing gift OR minted a
 *                  new one). Reversible.
 *   Needs review : status='pending' — uncertain; nothing applied to the ledger.
 *   Excluded     : status='excluded' — non-donation noise (auto or manual).
 *   (Done        : status='approved' that a human confirmed or created.)
 *
 * Listing/resolving is open to any authenticated fundraiser; sync / rematch /
 * reclassify are admin-gated. The connection itself is admin-gated in
 * quickbooksOauth.ts.
 *
 * This module is the composition root: it applies requireAuth once and mounts
 * the concern-specific sub-routers IN THEIR ORIGINAL REGISTRATION ORDER so
 * Express route matching is byte-for-byte identical to the pre-split router.
 * The actual handlers live under ./quickbooks/* and shared helpers/aliases live
 * in ./quickbooks/shared.
 */
const router: IRouter = Router();
router.use(requireAuth);

router.use(queueRouter);
router.use(actionsRouter);
router.use(candidatesRouter);
router.use(matchingRouter);
router.use(revertRouter);
router.use(syncRouter);

export default router;
