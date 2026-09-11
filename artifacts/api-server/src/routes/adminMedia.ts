import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { canStartFeedbackImplementation } from "../lib/feedbackImplementationAuth";
import {
  getMediaRelevanceBackfillStatus,
  startMediaRelevanceBackfill,
} from "../lib/mediaRelevanceBackfill";

const router: IRouter = Router();
router.use(requireAuth);

function requireAdmin(
  req: import("express").Request,
  res: import("express").Response,
): boolean {
  const actor = getAppUser(req);
  if (!actor || actor.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

router.get(
  "/admin/media-relevance-backfill",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const actor = getAppUser(req);
    const status = await getMediaRelevanceBackfillStatus();
    res.json({
      canRun: canStartFeedbackImplementation(actor),
      ...status,
    });
  }),
);

router.post(
  "/admin/media-relevance-backfill",
  asyncHandler(async (req, res) => {
    const actor = getAppUser(req);
    if (!canStartFeedbackImplementation(actor)) {
      res.status(403).json({
        error: "feedback_implementer_required",
        message:
          "Only the configured feedback implementer can start the historical media review.",
      });
      return;
    }

    const started = startMediaRelevanceBackfill();
    res.status(202).json({
      started,
      message: started
        ? "Historical media review started."
        : "Historical media review is already running on this app instance.",
    });
  }),
);

export default router;
