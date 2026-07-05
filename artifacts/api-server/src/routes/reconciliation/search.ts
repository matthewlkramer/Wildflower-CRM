import { Router, type IRouter } from "express";
import { asyncHandler, notFound } from "../../lib/helpers";
import { getViewer } from "../../lib/identityVisibility";
import {
  searchReconciliationNode,
  searchQbStaged,
  searchPayouts,
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

// A real ISO calendar date (YYYY-MM-DD). Format-only checks let "2026-13-40"
// through to the `::date` cast and raise a Postgres 500, so verify the value
// round-trips through Date before we build the query.
function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ─── GET /reconciliation/search/:nodeType ─────────────────────────────────
// Scoped, cross-filtering search for one node of a card's graph. Anchored to a
// money event — EXACTLY ONE of ?stagedPaymentId= (a QuickBooks card) or
// ?stripeChargeId= (a settlement-bundle Stripe charge row that has no staged
// payment) — so amount/date windows and the gift pool stay tied to that money.
// A Stripe charge anchors gift search on its GROSS amount + date and supports
// only `donor`/`gift` (opp/qb genuinely need the staged anchor). `donor` matches
// a trigram name search; `gift`/`opportunity` accept an optional donorId to
// narrow by donor; `qb` finds other staged rows by free text. All labels are
// anonymous-masked for the viewer.
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
    const stripeChargeId =
      typeof req.query["stripeChargeId"] === "string"
        ? req.query["stripeChargeId"]
        : "";
    if (Boolean(stagedPaymentId) === Boolean(stripeChargeId)) {
      res.status(400).json({
        error: "validation_error",
        message: "provide exactly one of stagedPaymentId or stripeChargeId",
      });
      return;
    }
    if (stripeChargeId && nodeType !== "donor" && nodeType !== "gift") {
      res.status(400).json({
        error: "validation_error",
        message: "a stripeChargeId anchor supports only donor and gift search",
      });
      return;
    }

    const q = typeof req.query["q"] === "string" ? req.query["q"] : null;
    const donorId =
      typeof req.query["donorId"] === "string" ? req.query["donorId"] : null;
    // Split mode (gift search only): candidate gifts are fractions of the
    // payment, not near-equal to it. Accept the standard truthy spellings.
    const split = req.query["split"] === "true" || req.query["split"] === "1";
    const days = clampInt(req.query["days"], 30, 1, 365);
    const limit = clampInt(req.query["limit"], 25, 1, 100);

    const data = await searchReconciliationNode({
      nodeType: nodeType as RecNodeType,
      stagedPaymentId,
      stripeChargeId: stripeChargeId || null,
      q,
      donorId,
      split,
      days,
      limit,
      viewer: getViewer(req),
    });
    if (data === null) return notFound(res, "reconciliation card");
    res.json({ data });
  }),
);

// ─── GET /reconciliation/qb-search ────────────────────────────────────────
// Criteria-based QuickBooks staged-payment search with NO card anchor — the
// stray-Stripe worklist uses this to hunt the QB deposit a yet-unmatched Stripe
// payout should belong to. Read-only; returns qb candidates (same shape as the
// card search). No donor names here, so no viewer masking is needed.
router.get(
  "/reconciliation/qb-search",
  asyncHandler(async (req, res) => {
    const q = typeof req.query["q"] === "string" ? req.query["q"] : null;
    const amount =
      typeof req.query["amount"] === "string" ? req.query["amount"] : null;
    const date =
      typeof req.query["date"] === "string" ? req.query["date"] : null;
    if (date && !isValidIsoDate(date)) {
      res.status(400).json({
        error: "validation_error",
        message: "date must be a valid YYYY-MM-DD date",
      });
      return;
    }
    const days = clampInt(req.query["days"], 30, 1, 365);
    const limit = clampInt(req.query["limit"], 25, 1, 100);

    const data = await searchQbStaged({ q, amount, date, days, limit });
    res.json({ data });
  }),
);

// ─── GET /reconciliation/payout-search ─────────────────────────────────────
// Reverse of qb-search: criteria-based ORPHAN Stripe payout search with NO card
// anchor — the Settlement report's "Missing payout" resolve box uses this to hunt
// the payout a standalone QuickBooks deposit should settle against. Read-only.
router.get(
  "/reconciliation/payout-search",
  asyncHandler(async (req, res) => {
    const q = typeof req.query["q"] === "string" ? req.query["q"] : null;
    const amount =
      typeof req.query["amount"] === "string" ? req.query["amount"] : null;
    const date =
      typeof req.query["date"] === "string" ? req.query["date"] : null;
    if (date && !isValidIsoDate(date)) {
      res.status(400).json({
        error: "validation_error",
        message: "date must be a valid YYYY-MM-DD date",
      });
      return;
    }
    const days = clampInt(req.query["days"], 30, 1, 365);
    const limit = clampInt(req.query["limit"], 25, 1, 100);

    const data = await searchPayouts({ q, amount, date, days, limit });
    res.json({ data });
  }),
);

export default router;
