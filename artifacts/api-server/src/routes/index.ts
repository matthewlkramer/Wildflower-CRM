import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import regionsRouter from "./regions";
import schoolsRouter from "./schools";
import lookupsRouter from "./lookups";
import entitiesRouter from "./entities";
import fiscalYearEntityGoalsRouter from "./fiscalYearEntityGoals";
import householdsRouter from "./households";
import paymentIntermediariesRouter from "./paymentIntermediaries";
import organizationsRouter from "./organizations";
import peopleRouter from "./people";
import peopleEntityRolesRouter from "./peopleEntityRoles";
import donorPaymentIntermediariesRouter from "./donorPaymentIntermediaries";
import emailsRouter from "./emails";
import phoneNumbersRouter from "./phoneNumbers";
import addressesRouter from "./addresses";
import opportunitiesRouter from "./opportunitiesAndPledges";
import pledgeAllocationsRouter from "./pledgeAllocations";
import giftsRouter from "./giftsAndPayments";
import giftAllocationsRouter from "./giftAllocations";
import analyticsRouter from "./analytics";
import interactionsRouter from "./interactions";
import googleOauthRouter from "./googleOauth";
import googleSyncRouter from "./googleSync";
import emailMessagesRouter from "./emailMessages";
import emailAttachmentsRouter from "./emailAttachments";
import calendarEventsRouter from "./calendarEvents";
import adminSyncRouter from "./adminSync";
import emailProposalsRouter from "./emailProposals";
import correspondentsRouter from "./correspondents";
import notesRouter from "./notes";
import mediaMentionsRouter from "./mediaMentions";
import tasksRouter from "./tasks";
import meetingNotesRouter from "./meetingNotes";
import savedViewsRouter from "./savedViews";
import storageRouter from "./storage";
import emailTrackingRouter from "./emailTracking";
import suppressionWindowsRouter from "./suppressionWindows";
import calendarMeetingFiltersRouter from "./calendarMeetingFiltersRoute";
import topPrioritiesRouter from "./topPriorities";

const router: IRouter = Router();

router.use(healthRouter);
// emailTrackingRouter mounts here (NOT at the bottom) on purpose. Several
// sub-routers below — usersRouter, regionsRouter, schoolsRouter, etc. —
// apply `router.use(requireAuth)` at module top, and Express runs that
// middleware for every request that walks through the sub-router whether
// or not one of its internal routes matches. Anything mounted after those
// routers is unreachable when unauthenticated. The Magio extension calls
// POST /email-tracking, GET /email-tracking/search|status, and the pixel
// endpoint anonymously from mail.google.com, so this router must be
// reachable before any auth-gated sub-router fires. Per-route requireAuth
// is still applied inside emailTrackingRouter for the CRM-facing reads.
router.use(emailTrackingRouter);
router.use(usersRouter);
router.use(regionsRouter);
router.use(schoolsRouter);
router.use(lookupsRouter);
router.use(entitiesRouter);
router.use(fiscalYearEntityGoalsRouter);
router.use(householdsRouter);
router.use(paymentIntermediariesRouter);
router.use(organizationsRouter);
router.use(peopleRouter);
router.use(peopleEntityRolesRouter);
router.use(donorPaymentIntermediariesRouter);
router.use(emailsRouter);
router.use(phoneNumbersRouter);
router.use(addressesRouter);
router.use(opportunitiesRouter);
router.use(pledgeAllocationsRouter);
router.use(giftsRouter);
router.use(giftAllocationsRouter);
router.use(analyticsRouter);
router.use(interactionsRouter);
router.use(googleOauthRouter);
router.use(googleSyncRouter);
router.use(emailMessagesRouter);
router.use(emailAttachmentsRouter);
router.use(calendarEventsRouter);
router.use(adminSyncRouter);
router.use(emailProposalsRouter);
router.use(correspondentsRouter);
router.use(notesRouter);
router.use(mediaMentionsRouter);
router.use(tasksRouter);
router.use(meetingNotesRouter);
router.use(savedViewsRouter);
router.use(storageRouter);
router.use(suppressionWindowsRouter);
router.use(calendarMeetingFiltersRouter);
router.use(topPrioritiesRouter);

export default router;
