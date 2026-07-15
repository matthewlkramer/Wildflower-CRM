import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { runDerivationHealthCheck } from "../lib/derivationHealth";

/**
 * Admin-only derivation health check (REPORT-ONLY — never writes).
 *
 * Re-derives every persisted-derived field through the same pure functions the
 * write-path appliers use and reports any row where stored ≠ derived. Drift
 * means some write path forgot its applier call (or raw SQL bypassed it) —
 * the report is the tripwire; the fix is a deliberate, separate act.
 */
const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/admin/derivation-health",
  asyncHandler(async (req, res) => {
    const me = getAppUser(req);
    if (!me || me.role !== "admin") {
      res.status(403).json({ error: "admin_required" });
      return;
    }
    const report = await runDerivationHealthCheck();
    res.json(report);
  }),
);

export default router;
