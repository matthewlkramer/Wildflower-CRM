import { db } from "@workspace/db";
import {
  donorboxDonations,
  donorboxSyncState,
  DONORBOX_SYNC_STATE_ID,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { withSyncLock } from "./syncLock";
import {
  isDonorboxConfigured,
  listDonations,
  type DonorboxDonationDTO,
} from "./donorboxClient";
import { scoreStripeCharge } from "./stripeMatch";

/**
 * Donorbox → CRM pull sync.
 *
 * Donorbox donations split two ways by `donationType`:
 *
 *   1. ENRICHMENT (donationType === "stripe") — the donation's stripeChargeId
 *      (ch_…) equals stripe_staged_charges.id. We persist the donation FACTS so
 *      the reconciliation card / gift detail can enrich the already-existing
 *      Stripe-sourced record. We NEVER mint a gift here (the Stripe sync already
 *      pulls those charges → minting would double-count). These rows stay at the
 *      default review state and never surface in the new-money worklist.
 *
 *   2. NEW MONEY (donationType !== "stripe") — money that does NOT flow through
 *      our Stripe sync. We persist the donation and seed a SUGGESTED donor match
 *      (never auto-applied), leaving the row `pending` for a human to link /
 *      mint / exclude in the new-money review queue. We NEVER auto-mint and
 *      NEVER write a staged_payments row.
 *
 * Idempotent: keyed on the Donorbox donation id, the upsert refreshes only
 * read-only Donorbox facts and preserves all review state (mirrors stripeSync).
 *
 * Unlike Stripe's ongoing-only first cut, the FIRST run pulls the full history
 * (Stripe-type donations must enrich historical gifts; non-Stripe donations
 * surface as candidates). Afterwards `donationCursor` advances to the newest
 * donation seen and each run re-pulls from `donationCursor − overlap` so refunds
 * and edits on recent donations are picked up. Advisory-locked (single account)
 * under the "donorbox" source tag.
 */

const CHICAGO_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** A JS Date → "YYYY-MM-DD" in America/Chicago (the org keeps central books). */
function chicagoDate(d: Date | null): string | null {
  if (!d) return null;
  return CHICAGO_DATE.format(d);
}

/** Re-pull window: how far before the cursor each run re-reads (refund/edit catch). */
const OVERLAP_MS = 21 * 24 * 60 * 60 * 1000; // 21 days

/** Safety cap on pages walked per run (100/page ⇒ up to 100k donations). */
const MAX_PAGES = 1000;

const PER_PAGE = 100;

export interface DonorboxSyncSummary {
  ran: boolean;
  pages: number;
  /** Rows the upsert touched (insert or fact-refresh). */
  upserted: number;
  /** Brand-new rows inserted this run. */
  inserted: number;
  /** New Stripe-type (enrichment) rows. */
  enrichment: number;
  /** New non-Stripe (new-money candidate) rows. */
  newMoney: number;
}

const EMPTY: DonorboxSyncSummary = {
  ran: false,
  pages: 0,
  upserted: 0,
  inserted: 0,
  enrichment: 0,
  newMoney: 0,
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Upsert one donation, refreshing read-only Donorbox facts on conflict and
 * preserving review state. `enrichAllStatuses` lifts the status guard so a full
 * re-pull refreshes facts even on resolved rows (never touches review state).
 * Returns the row id and whether this was a fresh insert (xmax = 0).
 */
function buildDonationUpsert(
  values: typeof donorboxDonations.$inferInsert,
  opts: { enrichAllStatuses?: boolean } = {},
) {
  const set = {
    donationType: sql`coalesce(excluded.donation_type, ${donorboxDonations.donationType})`,
    stripeChargeId: sql`coalesce(excluded.stripe_charge_id, ${donorboxDonations.stripeChargeId})`,
    paypalTransactionId: sql`coalesce(excluded.paypal_transaction_id, ${donorboxDonations.paypalTransactionId})`,
    amount: sql`coalesce(excluded.amount, ${donorboxDonations.amount})`,
    amountRefunded: sql`coalesce(excluded.amount_refunded, ${donorboxDonations.amountRefunded})`,
    processingFee: sql`coalesce(excluded.processing_fee, ${donorboxDonations.processingFee})`,
    currency: sql`coalesce(excluded.currency, ${donorboxDonations.currency})`,
    // Live facts that can flip after first ingest — always refresh.
    donationStatus: sql`excluded.donation_status`,
    refunded: sql`excluded.refunded`,
    recurring: sql`excluded.recurring`,
    donatedAt: sql`coalesce(excluded.donated_at, ${donorboxDonations.donatedAt})`,
    dateReceived: sql`coalesce(excluded.date_received, ${donorboxDonations.dateReceived})`,
    campaignId: sql`coalesce(excluded.campaign_id, ${donorboxDonations.campaignId})`,
    campaignName: sql`coalesce(excluded.campaign_name, ${donorboxDonations.campaignName})`,
    designation: sql`coalesce(excluded.designation, ${donorboxDonations.designation})`,
    comment: sql`coalesce(excluded.comment, ${donorboxDonations.comment})`,
    anonymous: sql`excluded.anonymous`,
    giftAid: sql`excluded.gift_aid`,
    donorName: sql`coalesce(excluded.donor_name, ${donorboxDonations.donorName})`,
    donorEmail: sql`coalesce(excluded.donor_email, ${donorboxDonations.donorEmail})`,
    donorFirstName: sql`coalesce(excluded.donor_first_name, ${donorboxDonations.donorFirstName})`,
    donorLastName: sql`coalesce(excluded.donor_last_name, ${donorboxDonations.donorLastName})`,
    donorPhone: sql`coalesce(excluded.donor_phone, ${donorboxDonations.donorPhone})`,
    donorEmployer: sql`coalesce(excluded.donor_employer, ${donorboxDonations.donorEmployer})`,
    utm: sql`coalesce(excluded.utm, ${donorboxDonations.utm})`,
    questions: sql`coalesce(excluded.questions, ${donorboxDonations.questions})`,
    raw: sql`coalesce(excluded.raw, ${donorboxDonations.raw})`,
    updatedAt: new Date(),
  };
  return db
    .insert(donorboxDonations)
    .values(values)
    .onConflictDoUpdate({
      target: donorboxDonations.id,
      set,
      ...(opts.enrichAllStatuses
        ? {}
        : {
            setWhere: sql`${donorboxDonations.status} in ('pending','excluded')`,
          }),
    })
    .returning({
      id: donorboxDonations.id,
      isInsert: sql<boolean>`(xmax = 0)`,
    });
}

/**
 * Seed a SUGGESTED donor match onto a freshly-inserted non-Stripe row — a hint
 * for the reviewer, NEVER auto-applied (no gift link, status stays pending).
 * Guarded to a still-unmatched pending row so a re-pull can't clobber human
 * edits. A scorer failure is swallowed (the row simply stays unmatched).
 */
async function seedDonorSuggestion(
  d: DonorboxDonationDTO,
  dateReceived: string | null,
): Promise<void> {
  try {
    const scored = await scoreStripeCharge({
      payerName: d.donorName,
      payerEmail: d.donorEmail,
      description: d.comment ?? d.designation,
      statementDescriptor: d.campaignName,
      grossAmount: d.amount,
      dateReceived,
    });
    if (scored.tier === "none") return;
    await db
      .update(donorboxDonations)
      .set({
        organizationId: scored.donor.organizationId,
        individualGiverPersonId: scored.donor.individualGiverPersonId,
        householdId: scored.donor.householdId,
        matchedPaymentIntermediaryId: scored.intermediaryId,
        matchStatus: scored.tier === "high" ? "matched" : "suggested",
        matchScore: scored.method ? scored.score : null,
        matchMethod: scored.method,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(donorboxDonations.id, d.id),
          eq(donorboxDonations.status, "pending"),
          eq(donorboxDonations.matchStatus, "unmatched"),
        ),
      );
  } catch (e) {
    logger.warn(
      { err: e, donationId: d.id },
      "Donorbox sync: donor scoring failed; leaving candidate unmatched",
    );
  }
}

function toInsertValues(
  d: DonorboxDonationDTO,
): typeof donorboxDonations.$inferInsert {
  return {
    id: d.id,
    donationType: d.donationType,
    stripeChargeId: d.stripeChargeId,
    paypalTransactionId: d.paypalTransactionId,
    amount: d.amount,
    amountRefunded: d.amountRefunded,
    processingFee: d.processingFee,
    currency: d.currency,
    donationStatus: d.donationStatus,
    refunded: d.refunded,
    recurring: d.recurring,
    donatedAt: d.donatedAt,
    dateReceived: chicagoDate(d.donatedAt),
    campaignId: d.campaignId,
    campaignName: d.campaignName,
    designation: d.designation,
    comment: d.comment,
    anonymous: d.anonymous,
    giftAid: d.giftAid,
    donorName: d.donorName,
    donorEmail: d.donorEmail,
    donorFirstName: d.donorFirstName,
    donorLastName: d.donorLastName,
    donorPhone: d.donorPhone,
    donorEmployer: d.donorEmployer,
    utm: d.utm ?? undefined,
    questions: (d.questions ?? undefined) as Record<string, unknown> | undefined,
    raw: (d.raw ?? undefined) as Record<string, unknown> | undefined,
  };
}

/**
 * Pull Donorbox donations and upsert them. `fullResync` ignores the watermark
 * (walks the full history) and lifts the upsert status guard so read-only facts
 * are refreshed even on resolved rows.
 */
export async function syncDonorbox(
  opts: { fullResync?: boolean } = {},
): Promise<DonorboxSyncSummary> {
  if (!isDonorboxConfigured()) {
    logger.debug("Donorbox sync: credentials not set, skipping");
    return EMPTY;
  }
  const fullResync = opts.fullResync === true;

  const outcome = await withSyncLock(
    DONORBOX_SYNC_STATE_ID,
    "donorbox",
    async () => {
      const startedAt = new Date();
      const state = await db
        .select()
        .from(donorboxSyncState)
        .where(eq(donorboxSyncState.id, DONORBOX_SYNC_STATE_ID))
        .then((r) => r[0]);

      const watermark = fullResync ? null : (state?.donationCursor ?? null);
      const floor = watermark
        ? new Date(watermark.getTime() - OVERLAP_MS)
        : null;

      // Mark the run as started (insert the singleton on first ever run).
      await db
        .insert(donorboxSyncState)
        .values({
          id: DONORBOX_SYNC_STATE_ID,
          lastRunStartedAt: startedAt,
          lastStatus: "running",
        })
        .onConflictDoUpdate({
          target: donorboxSyncState.id,
          set: { lastRunStartedAt: startedAt, lastStatus: "running" },
        });

      let pages = 0;
      let upserted = 0;
      let inserted = 0;
      let enrichment = 0;
      let newMoney = 0;
      let maxDonatedAt: Date | null = null;

      try {
        let page = 1;
        let reachedFloor = false;
        while (page <= MAX_PAGES) {
          const rows = await listDonations({
            page,
            perPage: PER_PAGE,
            order: "desc",
          });
          pages += 1;
          if (rows.length === 0) break;

          for (const d of rows) {
            // Incremental runs stop once we walk past the overlap floor (desc
            // order ⇒ everything after is older and already ingested).
            if (
              floor &&
              d.donatedAt &&
              d.donatedAt.getTime() < floor.getTime()
            ) {
              reachedFloor = true;
              continue;
            }

            const isStripe =
              (d.donationType ?? "").toLowerCase() === "stripe" ||
              !!d.stripeChargeId;

            const res = await buildDonationUpsert(toInsertValues(d), {
              enrichAllStatuses: fullResync,
            });
            upserted += 1;
            const row = res[0];
            if (row?.isInsert) {
              inserted += 1;
              if (isStripe) enrichment += 1;
              else {
                newMoney += 1;
                await seedDonorSuggestion(d, chicagoDate(d.donatedAt));
              }
            }

            if (
              d.donatedAt &&
              (maxDonatedAt === null || d.donatedAt > maxDonatedAt)
            ) {
              maxDonatedAt = d.donatedAt;
            }
          }

          if (reachedFloor) break;
          if (rows.length < PER_PAGE) break;
          page += 1;
        }

        // Never move the cursor backwards.
        let newCursor = watermark;
        if (maxDonatedAt && (!watermark || maxDonatedAt > watermark)) {
          newCursor = maxDonatedAt;
        }

        await db
          .update(donorboxSyncState)
          .set({
            donationCursor: newCursor,
            lastRunFinishedAt: new Date(),
            lastStatus: "ok",
            lastError: null,
            donationsUpserted: upserted,
            consecutiveErrors: 0,
            updatedAt: new Date(),
          })
          .where(eq(donorboxSyncState.id, DONORBOX_SYNC_STATE_ID));

        logger.info(
          { pages, upserted, inserted, enrichment, newMoney, fullResync },
          "Donorbox sync complete",
        );
        return { pages, upserted, inserted, enrichment, newMoney };
      } catch (e) {
        await db
          .update(donorboxSyncState)
          .set({
            lastRunFinishedAt: new Date(),
            lastStatus: "error",
            lastError: errMsg(e),
            consecutiveErrors: sql`${donorboxSyncState.consecutiveErrors} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(donorboxSyncState.id, DONORBOX_SYNC_STATE_ID));
        throw e;
      }
    },
  );

  if (!outcome.ran) return EMPTY;
  return { ran: true, ...outcome.result! };
}
