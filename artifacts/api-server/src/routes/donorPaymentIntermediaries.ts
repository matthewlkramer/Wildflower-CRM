import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  donorPaymentIntermediaries,
  giftsAndPayments,
  paymentIntermediaries,
} from "@workspace/db/schema";
import {
  and,
  desc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  CreateDonorPaymentIntermediaryBody,
  DONOR_XOR_MESSAGE,
  ListDonorPaymentIntermediariesQueryParams,
  UpdateDonorPaymentIntermediaryBody,
  validateGiftInvariants,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  asyncHandler,
  newId,
  notFound,
  paramId,
  parseOrBadRequest,
} from "../lib/helpers";
import { diffChanges, recordAudit } from "../lib/audit";
import { resolveDonorRouting, type DonorRef } from "../lib/donorRouting";

const router: IRouter = Router();
router.use(requireAuth);

const piSelect = {
  id: paymentIntermediaries.id,
  name: paymentIntermediaries.name,
  type: paymentIntermediaries.type,
  archivedAt: paymentIntermediaries.archivedAt,
  createdAt: paymentIntermediaries.createdAt,
  updatedAt: paymentIntermediaries.updatedAt,
};

const linkSelect = {
  ...getTableColumns(donorPaymentIntermediaries),
  paymentIntermediary: piSelect,
};

type DonorColumns = {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
};

function badDonorXor(res: import("express").Response): void {
  res.status(400).json({
    error: "validation_error",
    message: DONOR_XOR_MESSAGE,
    details: {
      issues: [{ path: ["organizationId"], message: DONOR_XOR_MESSAGE }],
    },
  });
}

function donorWhere(donor: DonorColumns) {
  if (donor.organizationId) {
    return eq(donorPaymentIntermediaries.organizationId, donor.organizationId);
  }
  if (donor.individualGiverPersonId) {
    return eq(
      donorPaymentIntermediaries.individualGiverPersonId,
      donor.individualGiverPersonId,
    );
  }
  return eq(
    donorPaymentIntermediaries.householdId,
    donor.householdId as string,
  );
}

function donorRef(donor: DonorColumns): DonorRef {
  if (donor.organizationId) {
    return { kind: "organization", id: donor.organizationId };
  }
  if (donor.individualGiverPersonId) {
    return { kind: "individual", id: donor.individualGiverPersonId };
  }
  return { kind: "household", id: donor.householdId as string };
}

async function loadLink(id: string) {
  const [row] = await db
    .select(linkSelect)
    .from(donorPaymentIntermediaries)
    .innerJoin(
      paymentIntermediaries,
      eq(
        paymentIntermediaries.id,
        donorPaymentIntermediaries.paymentIntermediaryId,
      ),
    )
    .where(eq(donorPaymentIntermediaries.id, id))
    .limit(1);
  return row ?? null;
}

async function effectiveDefault(source: DonorRef) {
  const resolution = await resolveDonorRouting(source);
  const resolved = resolution.resolved;
  const result = await db.execute(sql`
    SELECT
      resolve_default_payment_intermediary(
        ${source.kind}, ${source.id}, ${source.kind}, ${source.id}
      ) AS source_id,
      resolve_default_payment_intermediary(
        ${source.kind}, ${source.id},
        ${resolved?.kind ?? null}, ${resolved?.id ?? null}
      ) AS effective_id
  `);
  const ids = result.rows[0] as
    | { source_id: string | null; effective_id: string | null }
    | undefined;
  if (!ids?.effective_id) {
    return { paymentIntermediary: null, source: null } as const;
  }
  const [paymentIntermediary] = await db
    .select(piSelect)
    .from(paymentIntermediaries)
    .where(
      and(
        eq(paymentIntermediaries.id, ids.effective_id),
        isNull(paymentIntermediaries.archivedAt),
      ),
    )
    .limit(1);
  return {
    paymentIntermediary: paymentIntermediary ?? null,
    source: paymentIntermediary
      ? ids.source_id === ids.effective_id
        ? ("source" as const)
        : ("resolved" as const)
      : null,
  };
}

router.get(
  "/donor-payment-intermediaries",
  asyncHandler(async (req, res) => {
    const q = parseOrBadRequest(
      ListDonorPaymentIntermediariesQueryParams,
      req.query,
      res,
    );
    if (!q) return;
    const donor: DonorColumns = {
      organizationId: q.organizationId ?? null,
      individualGiverPersonId: q.individualGiverPersonId ?? null,
      householdId: q.householdId ?? null,
    };
    if (validateGiftInvariants(donor).length > 0) return badDonorXor(res);

    const linkDonorWhere = donorWhere(donor);
    const giftDonorWhere = donor.organizationId
      ? eq(giftsAndPayments.organizationId, donor.organizationId)
      : donor.individualGiverPersonId
        ? eq(
            giftsAndPayments.individualGiverPersonId,
            donor.individualGiverPersonId,
          )
        : eq(giftsAndPayments.householdId, donor.householdId as string);

    const [data, allLogged, defaultResult] = await Promise.all([
      db
        .select(linkSelect)
        .from(donorPaymentIntermediaries)
        .innerJoin(
          paymentIntermediaries,
          eq(
            paymentIntermediaries.id,
            donorPaymentIntermediaries.paymentIntermediaryId,
          ),
        )
        .where(
          and(
            linkDonorWhere,
            isNull(donorPaymentIntermediaries.archivedAt),
            isNull(paymentIntermediaries.archivedAt),
          ),
        )
        .orderBy(
          desc(donorPaymentIntermediaries.isDefault),
          desc(donorPaymentIntermediaries.createdAt),
        ),
      db
        .select({
          paymentIntermediaryId:
            donorPaymentIntermediaries.paymentIntermediaryId,
        })
        .from(donorPaymentIntermediaries)
        .where(linkDonorWhere),
      effectiveDefault(donorRef(donor)),
    ]);

    // A previously archived link stays dismissed from suggestions. It can be
    // restored by searching for the intermediary and adding it again.
    const loggedPiIds = allLogged.map((row) => row.paymentIntermediaryId);
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
          isNull(paymentIntermediaries.archivedAt),
          loggedPiIds.length
            ? notInArray(paymentIntermediaries.id, loggedPiIds)
            : undefined,
        ),
      )
      .orderBy(paymentIntermediaries.name);

    res.json({
      data,
      giftDerived,
      effectiveDefaultPaymentIntermediary: defaultResult.paymentIntermediary,
      effectiveDefaultSource: defaultResult.source,
    });
  }),
);

router.post(
  "/donor-payment-intermediaries",
  asyncHandler(async (req, res) => {
    const body = parseOrBadRequest(
      CreateDonorPaymentIntermediaryBody,
      req.body,
      res,
    );
    if (!body) return;
    if (validateGiftInvariants(body).length > 0) return badDonorXor(res);

    const [intermediary] = await db
      .select({ id: paymentIntermediaries.id })
      .from(paymentIntermediaries)
      .where(
        and(
          eq(paymentIntermediaries.id, body.paymentIntermediaryId),
          isNull(paymentIntermediaries.archivedAt),
        ),
      )
      .limit(1);
    if (!intermediary) {
      res.status(409).json({
        error: "payment_intermediary_unavailable",
        message: "The payment intermediary is missing or archived.",
      });
      return;
    }

    const donor: DonorColumns = {
      organizationId: body.organizationId ?? null,
      individualGiverPersonId: body.individualGiverPersonId ?? null,
      householdId: body.householdId ?? null,
    };
    const result = await db.transaction(async (tx) => {
      const source = donorRef(donor);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${source.kind}:${source.id}:${body.paymentIntermediaryId}:donor-payment-intermediary`}))`,
      );
      const [existing] = await tx
        .select()
        .from(donorPaymentIntermediaries)
        .where(
          and(
            donorWhere(donor),
            eq(
              donorPaymentIntermediaries.paymentIntermediaryId,
              body.paymentIntermediaryId,
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (existing) {
        if (!existing.archivedAt) return existing.id;
        const [restored] = await tx
          .update(donorPaymentIntermediaries)
          .set({
            archivedAt: null,
            notes: body.notes ?? existing.notes,
            updatedAt: new Date(),
          })
          .where(eq(donorPaymentIntermediaries.id, existing.id))
          .returning();
        await recordAudit(tx, req, {
          action: "unarchive",
          entityType: "donor_payment_intermediary",
          entityId: existing.id,
          summary: "Restored a donor payment intermediary relationship",
          changes: diffChanges(existing, restored, ["archivedAt", "notes"]),
        });
        return existing.id;
      }

      const [created] = await tx
        .insert(donorPaymentIntermediaries)
        .values({ id: newId(), ...body })
        .returning();
      await recordAudit(tx, req, {
        action: "create",
        entityType: "donor_payment_intermediary",
        entityId: created.id,
        summary: "Linked a payment intermediary to a donor",
      });
      return created.id;
    });

    const row = await loadLink(result);
    res.status(201).json(row);
  }),
);

router.patch(
  "/donor-payment-intermediaries/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(
      UpdateDonorPaymentIntermediaryBody,
      req.body,
      res,
    );
    if (!body) return;

    try {
      const updated = await db.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(donorPaymentIntermediaries)
          .where(eq(donorPaymentIntermediaries.id, id))
          .limit(1);
        if (!candidate) return null;
        if (body.isDefault) {
          const source = donorRef(candidate);
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${source.kind}:${source.id}:payment-intermediary-default`}))`,
          );
        }
        const [before] = await tx
          .select()
          .from(donorPaymentIntermediaries)
          .where(eq(donorPaymentIntermediaries.id, id))
          .for("update")
          .limit(1);
        if (!before) return null;
        if (body.isDefault && before.archivedAt) {
          throw new Error("payment_intermediary_unavailable");
        }
        if (body.isDefault) {
          const [intermediary] = await tx
            .select({ id: paymentIntermediaries.id })
            .from(paymentIntermediaries)
            .where(
              and(
                eq(paymentIntermediaries.id, before.paymentIntermediaryId),
                isNull(paymentIntermediaries.archivedAt),
              ),
            )
            .limit(1);
          if (!intermediary) {
            throw new Error("payment_intermediary_unavailable");
          }
          const replacedDefaults = await tx
            .select()
            .from(donorPaymentIntermediaries)
            .where(
              and(
                donorWhere(before),
                eq(donorPaymentIntermediaries.isDefault, true),
              ),
            );
          await tx
            .update(donorPaymentIntermediaries)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                donorWhere(before),
                eq(donorPaymentIntermediaries.isDefault, true),
              ),
            );
          for (const replaced of replacedDefaults) {
            if (replaced.id === id) continue;
            await recordAudit(tx, req, {
              action: "update",
              entityType: "donor_payment_intermediary",
              entityId: replaced.id,
              summary: "Replaced a donor's preferred payment intermediary",
              changes: [{ field: "isDefault", from: true, to: false }],
            });
          }
        }

        const changes: {
          notes?: string | null;
          isDefault?: boolean;
          updatedAt: Date;
        } = { updatedAt: new Date() };
        if (Object.prototype.hasOwnProperty.call(body, "notes")) {
          changes.notes = body.notes ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "isDefault")) {
          changes.isDefault = body.isDefault ?? false;
        }
        const [after] = await tx
          .update(donorPaymentIntermediaries)
          .set(changes)
          .where(eq(donorPaymentIntermediaries.id, id))
          .returning();
        const auditChanges = diffChanges(before, after, Object.keys(body));
        if (auditChanges.length > 0) {
          await recordAudit(tx, req, {
            action: "update",
            entityType: "donor_payment_intermediary",
            entityId: id,
            summary: body.isDefault
              ? "Changed a donor's preferred payment intermediary"
              : "Updated a donor payment intermediary relationship",
            changes: auditChanges,
          });
        }
        return after;
      });
      if (!updated) return notFound(res, "donor payment intermediary");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "payment_intermediary_unavailable"
      ) {
        res.status(409).json({
          error: "payment_intermediary_unavailable",
          message: "The payment intermediary is missing or archived.",
        });
        return;
      }
      throw error;
    }

    const row = await loadLink(id);
    res.json(row);
  }),
);

router.post(
  "/donor-payment-intermediaries/:id/archive",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const found = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(donorPaymentIntermediaries)
        .where(eq(donorPaymentIntermediaries.id, id))
        .for("update")
        .limit(1);
      if (!before) return false;
      if (!before.archivedAt) {
        const [after] = await tx
          .update(donorPaymentIntermediaries)
          .set({
            archivedAt: new Date(),
            isDefault: false,
            updatedAt: new Date(),
          })
          .where(eq(donorPaymentIntermediaries.id, id))
          .returning();
        await recordAudit(tx, req, {
          action: "archive",
          entityType: "donor_payment_intermediary",
          entityId: id,
          summary: "Archived a donor payment intermediary relationship",
          changes: diffChanges(before, after, ["archivedAt", "isDefault"]),
        });
      }
      return true;
    });
    if (!found) return notFound(res, "donor payment intermediary");
    const row = await loadLink(id);
    res.json(row);
  }),
);

router.post(
  "/donor-payment-intermediaries/:id/unarchive",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    try {
      const found = await db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(donorPaymentIntermediaries)
          .where(eq(donorPaymentIntermediaries.id, id))
          .for("update")
          .limit(1);
        if (!before) return false;
        const [intermediary] = await tx
          .select({ id: paymentIntermediaries.id })
          .from(paymentIntermediaries)
          .where(
            and(
              eq(paymentIntermediaries.id, before.paymentIntermediaryId),
              isNull(paymentIntermediaries.archivedAt),
            ),
          )
          .limit(1);
        if (!intermediary) {
          throw new Error("payment_intermediary_unavailable");
        }
        if (before.archivedAt) {
          const [after] = await tx
            .update(donorPaymentIntermediaries)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(eq(donorPaymentIntermediaries.id, id))
            .returning();
          await recordAudit(tx, req, {
            action: "unarchive",
            entityType: "donor_payment_intermediary",
            entityId: id,
            summary: "Restored a donor payment intermediary relationship",
            changes: diffChanges(before, after, ["archivedAt"]),
          });
        }
        return true;
      });
      if (!found) return notFound(res, "donor payment intermediary");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "payment_intermediary_unavailable"
      ) {
        res.status(409).json({
          error: "payment_intermediary_unavailable",
          message:
            "Restore the payment intermediary before restoring this relationship.",
        });
        return;
      }
      throw error;
    }
    const row = await loadLink(id);
    res.json(row);
  }),
);

export default router;
