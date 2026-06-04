import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  donorPaymentIntermediaries,
  paymentIntermediaries,
  giftsAndPayments,
} from "@workspace/db/schema";
import { and, desc, eq, getTableColumns, isNotNull, notInArray } from "drizzle-orm";
import {
  ListDonorPaymentIntermediariesQueryParams,
  CreateDonorPaymentIntermediaryBody,
  validateGiftInvariants,
  DONOR_XOR_MESSAGE,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, paramId, parseOrBadRequest } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

// Embedded payment-intermediary shape mirrored in every response item.
const piSelect = {
  id: paymentIntermediaries.id,
  name: paymentIntermediaries.name,
  type: paymentIntermediaries.type,
  createdAt: paymentIntermediaries.createdAt,
  updatedAt: paymentIntermediaries.updatedAt,
};

const linkSelect = {
  ...getTableColumns(donorPaymentIntermediaries),
  paymentIntermediary: piSelect,
};

// 400 if not exactly one donor key is set, mirroring the donor-XOR DB CHECK.
function badDonorXor(res: import("express").Response): void {
  res.status(400).json({
    error: "validation_error",
    message: DONOR_XOR_MESSAGE,
    details: { issues: [{ path: ["organizationId"], message: DONOR_XOR_MESSAGE }] },
  });
}

router.get(
  "/donor-payment-intermediaries",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(ListDonorPaymentIntermediariesQueryParams, req.query, res);
    if (!q) return;
    // Exactly one donor filter is required — this is a per-donor card.
    const donor = {
      organizationId: q.organizationId ?? null,
      individualGiverPersonId: q.individualGiverPersonId ?? null,
      householdId: q.householdId ?? null,
    };
    if (validateGiftInvariants(donor).length > 0) return badDonorXor(res);

    const linkDonorWhere = donor.organizationId
      ? eq(donorPaymentIntermediaries.organizationId, donor.organizationId)
      : donor.individualGiverPersonId
        ? eq(donorPaymentIntermediaries.individualGiverPersonId, donor.individualGiverPersonId)
        : eq(donorPaymentIntermediaries.householdId, donor.householdId as string);

    const giftDonorWhere = donor.organizationId
      ? eq(giftsAndPayments.organizationId, donor.organizationId)
      : donor.individualGiverPersonId
        ? eq(giftsAndPayments.individualGiverPersonId, donor.individualGiverPersonId)
        : eq(giftsAndPayments.householdId, donor.householdId as string);

    const data = await db
      .select(linkSelect)
      .from(donorPaymentIntermediaries)
      .innerJoin(
        paymentIntermediaries,
        eq(paymentIntermediaries.id, donorPaymentIntermediaries.paymentIntermediaryId),
      )
      .where(linkDonorWhere)
      .orderBy(desc(donorPaymentIntermediaries.createdAt));

    // Intermediaries seen on this donor's gifts but not yet logged as links.
    const loggedPiIds = data.map((d) => d.paymentIntermediaryId);
    const giftDerived = await db
      .selectDistinct(piSelect)
      .from(giftsAndPayments)
      .innerJoin(
        paymentIntermediaries,
        eq(paymentIntermediaries.id, giftsAndPayments.paymentIntermediaryId),
      )
      .where(
        and(
          giftDonorWhere,
          isNotNull(giftsAndPayments.paymentIntermediaryId),
          loggedPiIds.length ? notInArray(paymentIntermediaries.id, loggedPiIds) : undefined,
        ),
      )
      .orderBy(paymentIntermediaries.name);

    res.json({ data, giftDerived });
  }),
);

router.post(
  "/donor-payment-intermediaries",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(CreateDonorPaymentIntermediaryBody, req.body, res);
    if (!body) return;
    if (validateGiftInvariants(body).length > 0) return badDonorXor(res);

    // Idempotent on the (donor, intermediary) partial-unique indexes: a repeat
    // add returns the existing link instead of a 500.
    const inserted = await db
      .insert(donorPaymentIntermediaries)
      .values({ id: newId(), ...body })
      .onConflictDoNothing()
      .returning({ id: donorPaymentIntermediaries.id });

    let id: string;
    if (inserted.length > 0) {
      id = inserted[0].id;
    } else {
      const donorWhere = body.organizationId
        ? eq(donorPaymentIntermediaries.organizationId, body.organizationId)
        : body.individualGiverPersonId
          ? eq(donorPaymentIntermediaries.individualGiverPersonId, body.individualGiverPersonId)
          : eq(donorPaymentIntermediaries.householdId, body.householdId as string);
      const [existing] = await db
        .select({ id: donorPaymentIntermediaries.id })
        .from(donorPaymentIntermediaries)
        .where(
          and(
            donorWhere,
            eq(donorPaymentIntermediaries.paymentIntermediaryId, body.paymentIntermediaryId),
          ),
        )
        .limit(1);
      id = existing.id;
    }

    const [row] = await db
      .select(linkSelect)
      .from(donorPaymentIntermediaries)
      .innerJoin(
        paymentIntermediaries,
        eq(paymentIntermediaries.id, donorPaymentIntermediaries.paymentIntermediaryId),
      )
      .where(eq(donorPaymentIntermediaries.id, id))
      .limit(1);
    res.status(201).json(row);
  }),
);

router.delete(
  "/donor-payment-intermediaries/:id",
  asyncHandler(async (req, res) => {
    await db
      .delete(donorPaymentIntermediaries)
      .where(eq(donorPaymentIntermediaries.id, paramId(req)));
    res.status(204).end();
  }),
);

export default router;
