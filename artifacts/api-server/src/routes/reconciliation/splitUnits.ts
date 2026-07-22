import { Router, type IRouter } from "express";
import { requireFinance } from "../../lib/financeGuard";
import { db } from "@workspace/db";
import { asyncHandler, parseOrBadRequest } from "../../lib/helpers";
import { ReconcileAbort } from "../../lib/reconciliationCommit";
import { SplitStagedPaymentIntoUnitsBody } from "@workspace/api-zod";
import {
  splitStagedPaymentIntoUnits,
  revertStagedPaymentSplitUnits,
} from "../../lib/stagedPaymentSplitUnits";

/**
 * Split a QuickBooks staged row into synthetic reconciliation UNITS and undo
 * it. Accounting-changing gesture → finance permission. All invariants
 * (sum-to-parent, no nesting, claim-freedom) live in the split service,
 * which throws ReconcileAbort with the specific consistency-gate payload —
 * the transaction rolls back and nothing is written.
 */
const router: IRouter = Router();

router.post(
  "/reconciliation/staged-payments/:id/split-units",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const id = req.params.id as string;
    const body = parseOrBadRequest(SplitStagedPaymentIntoUnitsBody, req.body, res);
    if (!body) return;
    try {
      const result = await db.transaction((tx) =>
        splitStagedPaymentIntoUnits(tx, id, body.units),
      );
      res.json(result);
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }
  }),
);

router.post(
  "/reconciliation/staged-payments/:id/unsplit-units",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const id = req.params.id as string;
    try {
      const result = await db.transaction((tx) =>
        revertStagedPaymentSplitUnits(tx, id),
      );
      res.json(result);
    } catch (e) {
      if (e instanceof ReconcileAbort) {
        res.status(e.httpStatus).json(e.payload);
        return;
      }
      throw e;
    }
  }),
);

export default router;
