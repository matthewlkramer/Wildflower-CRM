import { Router, type IRouter } from "express";
import { asyncHandler, notFound, paramId } from "../../lib/helpers";
import { getAppUser } from "../../lib/appRequest";
import { RevertStagedPaymentMatchesBody } from "@workspace/api-zod";
import { revertOneStagedPayment } from "./shared";
import {
  reconAudit,
  fmtMoney,
  payerLabel,
} from "../../lib/reconciliationAudit";

const router: IRouter = Router();

// ─── POST /staged-payments/:id/revert ──────────────────────────────────────
router.post(
  "/staged-payments/:id/revert",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = paramId(req);

    const outcome = await revertOneStagedPayment(id);
    if (!outcome.ok) {
      if (outcome.reason === "not_found") {
        return notFound(res, "staged payment");
      }
      res.status(409).json({
        error: "not_revertible",
        message:
          "Only an auto-matched row or a reconciled-to-existing-gift row can be reverted.",
      });
      return;
    }
    void user;
    // The revert IS the undo — re-doing the original action is a fresh
    // decision made from the queue, so no undo pointer.
    await reconAudit(req, {
      action: "update",
      entityType: "staged_payment",
      entityId: id,
      summary: `Reverted the QuickBooks payment from ${payerLabel(outcome.row?.payerName)} (${fmtMoney(outcome.row?.amount)}) back to the queue`,
      undo: null,
    });
    res.json(outcome.row);
  }),
);

// ─── POST /staged-payments/revert-matches ──────────────────────────────────
// Bulk equivalent of the single revert above: reverts every revertible row
// among the submitted ids and SKIPS the rest (missing / not-revertible), so a
// partial batch never fails as a whole. Each row reverts in its own
// transaction; `requested` counts the raw submitted ids.
router.post(
  "/staged-payments/revert-matches",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = RevertStagedPaymentMatchesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const requested = parsed.data.ids.length;
    const ids = Array.from(new Set(parsed.data.ids));
    const revertedIds: string[] = [];
    for (const id of ids) {
      const outcome = await revertOneStagedPayment(id);
      if (outcome.ok) revertedIds.push(id);
    }
    void user;
    res.json({ revertedIds, requested });
  }),
);

export default router;
