import { Router, type IRouter } from "express";
import healthRouter from "./health";
import individualsRouter from "./individuals";
import householdsRouter from "./households";
import fundingEntitiesRouter from "./fundingEntities";
import opportunitiesRouter from "./opportunities";
import pledgesRouter from "./pledges";
import giftsRouter from "./gifts";
import movesRouter from "./moves";
import dashboardRouter from "./dashboard";
import projectionsRouter from "./projections";
import grantsCalendarRouter from "./grantsCalendar";
import usersRouter from "./usersRoute";
import contactsRouter from "./contacts";
import campaignsRouter from "./campaigns";
import cultivationTeamRouter from "./cultivationTeam";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/individuals", individualsRouter);
router.use("/households", householdsRouter);
router.use("/funding-entities", fundingEntitiesRouter);
router.use("/opportunities", opportunitiesRouter);
router.use("/pledges", pledgesRouter);
router.use("/gifts", giftsRouter);
router.use("/moves", movesRouter);
router.use("/dashboard", dashboardRouter);
router.use("/projections", projectionsRouter);
router.use("/grants-calendar", grantsCalendarRouter);
router.use("/users", usersRouter);
router.use("/contacts", contactsRouter);
router.use("/campaigns", campaignsRouter);
router.use("/cultivation-team", cultivationTeamRouter);

export default router;
