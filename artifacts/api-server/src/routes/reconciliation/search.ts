import { Router, type IRouter } from "express";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getViewer } from "../../lib/identityVisibility";
import {
  searchReconciliationNode,
  type RecNodeType,
} from "../../lib/reconciliationGraph";

const router: IRouter = Router();

const NODE_TYPES: readonly RecNodeType[] = [
  "donor",
  "gift",
  "opportunity",
  "qb",
];

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ─── GET /reconciliation/search/:nodeType ─────────────────────────────────
// Scoped, cross-filtering search for one node of a card's graph. Always anchored
// to a staged payment (?stagedPaymentId=) so amount/date windows and the gift
// pool stay tied to the money event. `donor` matches a trigram name search;
// `gift`/`opportunity` accept an optional donorId to narrow by donor; `qb` finds
// other staged rows by free text. All labels are anonymous-masked for the viewer.
router.get(
  "/reconciliation/search/:nodeType",
  asyncHandler(async (req, res) => {
    const nodeType = req.params["nodeType"] ?? "";
    if (!NODE_TYPES.includes(nodeType as RecNodeType)) {
      res
        .status(400)
        .json({ error: "validation_error", message: "invalid nodeType" });
      return;
    }
    const stagedPaymentId =
      typeof req.query["stagedPaymentId"] === "string"
        ? req.query["stagedPaymentId"]
        : "";
    if (!stagedPaymentId) {
      res.status(400).json({
        error: "validation_error",
        message: "stagedPaymentId is required",
      });
      return;
    }

    const q = typeof req.query["q"] === "string" ? req.query["q"] : null;
    const donorId =
      typeof req.query["donorId"] === "string" ? req.query["donorId"] : null;
    const days = clampInt(req.query["days"], 30, 1, 365);
    const limit = clampInt(req.query["limit"], 25, 1, 100);

    const data = await searchReconciliationNode({
      nodeType: nodeType as RecNodeType,
      stagedPaymentId,
      q,
      donorId,
      days,
      limit,
      viewer: getViewer(req),
    });
    if (data === null) return notFound(res, "reconciliation card");
    res.json({ data });
  }),
);

export default router;
