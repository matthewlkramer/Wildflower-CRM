import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { asc } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/users",
  asyncHandler(async (_req, res) => {
    const rows = await db.select().from(users).orderBy(asc(users.email));
    res.json(rows);
  }),
);

router.get(
  "/users/me",
  asyncHandler(async (req, res) => {
    res.json(getAppUser(req));
  }),
);

export default router;
