import { Router, type IRouter } from "express";
import { requireAuth } from "../../middlewares/requireAuth";
import cardsRouter from "./cards";
import searchRouter from "./search";
import approveRouter from "./approve";
import giftsMissingQbRouter from "./gifts-missing-qb";
import proposalsRouter from "./proposals";
import lineageRouter from "./lineage";
import bundlesRouter from "./bundles";
import bundleProposalsRouter from "./bundleProposals";
import bundleAnchorsRouter from "./bundleAnchors";

/**
 * Unified "complete-match" reconciler. One card per money event, anchored on a
 * REQUIRED QuickBooks staged_payments row, closing a 4-node graph (qb anchor +
 * donor + gift + opportunity/pledge) with Stripe per-charge detail as OPTIONAL
 * supporting evidence. Read-only here: cards/graph/search only propose; every
 * apply (and any mint) is human-driven through the existing reconcile paths.
 *
 * Composition root: applies requireAuth once and mounts the concern-specific
 * sub-routers (cards + graph, scoped node search). Listing/searching is open to
 * any authenticated fundraiser; the actual apply lives on the legacy routes.
 */
const router: IRouter = Router();

router.use(requireAuth);
router.use(cardsRouter);
router.use(searchRouter);
router.use(approveRouter);
router.use(giftsMissingQbRouter);
router.use(proposalsRouter);
router.use(lineageRouter);
router.use(bundlesRouter);
router.use(bundleProposalsRouter);
router.use(bundleAnchorsRouter);

export default router;
