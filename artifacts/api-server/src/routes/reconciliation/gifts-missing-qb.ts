import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  giftsAndPayments,
  giftAllocations,
  organizations,
  people,
  households,
  entities,
  fundableProjects,
  schools,
  stagedPayments,
  stripeStagedCharges,
  opportunitiesAndPledges,
} from "@workspace/db/schema";
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { asyncHandler } from "../../lib/helpers";
import { getViewer, maskName } from "../../lib/identityVisibility";
import {
  escapeLike,
  stagedSearchWhere,
  stagedSearchWhereExpr,
} from "../quickbooks/shared";
import {
  stripeChargeSearchWhere,
  stripeChargeSearchWhereExpr,
} from "../../lib/stripeChargeSearch";
import { giftMatchAmountBoundsKnownNet } from "../../lib/giftMatch";
import { stagedStatusWhere, chargeStatusWhere } from "../../lib/derivedStatus";
import {
  qbLedgerExistsForGift,
  stripeLedgerExistsForGift,
  donorboxLedgerExistsForGift,
} from "../../lib/paymentApplications";
import { reimbursablePledgeExistsSql } from "../../lib/reimbursablePlaceholder";

const router: IRouter = Router();

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

// Allowed gift payment methods (mirrors giftPaymentMethodEnum / the openapi
// GiftPaymentMethod enum) — validated so a bad query param can't raise a
// Postgres "invalid input value for enum" 500 on the enum comparison.
const PAYMENT_METHODS = new Set([
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
]);

// COALESCE(full_name, "first last") — nicer person display than raw full_name.
const personNameSql = sql<string | null>`
  COALESCE(
    NULLIF(TRIM(${people.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
  )`;

interface ProposedPayment {
  source: "quickbooks" | "stripe";
  stagedPaymentId: string | null;
  stripeChargeId: string | null;
  payerName: string | null;
  amount: string | null;
  dateReceived: string | null;
  paymentMethod: string | null;
  reference: string | null;
}

// Best-guess UNLINKED QuickBooks staged payment for a stray gift row — the same
// match the manual Link dialog surfaces (searchQbStaged): donor name over the
// payer/memo/line fields, a generous ±20%/±$50 amount band (QB gross vs Stripe
// net differ by fees), and a ±30d date window. Restricted to staged rows not yet
// tied to a gift (matched / created / group-reconciled all null) so a proposal is
// always actionable, and ordered so the single closest amount-then-date row wins.
// Returns null when nothing plausible matches (Stripe fallback runs next).
async function proposeQbPaymentForGift(opts: {
  rawDonorName: string | null;
  amount: string | null;
  date: string | null;
}): Promise<ProposedPayment | null> {
  const amt =
    opts.amount != null && opts.amount !== "" ? Number(opts.amount) : NaN;
  const hasAmount = Number.isFinite(amt) && amt > 0;
  const name = (opts.rawDonorName ?? "").trim();
  const hasText = name.length >= 2;
  // Need at least a donor name or an amount to make a meaningful proposal.
  if (!hasText && !hasAmount) return null;

  const conds: SQL[] = [
    sql`${stagedPayments.matchedGiftId} IS NULL`,
    sql`${stagedPayments.createdGiftId} IS NULL`,
    sql`${stagedPayments.groupReconciledGiftId} IS NULL`,
    // A row can be resolved WITHOUT a gift link: a settlement-only confirm
    // settles the deposit (payout↔deposit tie, no gift), and excluded rows
    // aren't donation money. Proposing any of those is a dead end (the
    // one-click Link 409s on a non-pending row) — and worse, a settled deposit
    // here shadows the gift's real match, the Stripe charge behind that
    // settlement (the fallback below never runs). The DERIVED pending
    // predicate keeps the proposal pool actionable (open work only).
    stagedStatusWhere.pending,
  ];
  if (hasText) {
    const w = stagedSearchWhere(name);
    if (w) conds.push(w);
  }
  if (hasAmount) {
    const lo = Math.min(amt * 0.8, amt - 50);
    const hi = Math.max(amt * 1.2, amt + 50);
    conds.push(
      sql`${stagedPayments.amount} IS NOT NULL AND (${stagedPayments.amount})::numeric BETWEEN ${lo} AND ${hi}`,
    );
  }
  if (opts.date) {
    conds.push(
      sql`${stagedPayments.dateReceived} IS NOT NULL AND ${stagedPayments.dateReceived} BETWEEN (${opts.date}::date - 30) AND (${opts.date}::date + 30)`,
    );
  }

  // Rank the single best candidate: closest amount, then closest date. Only add
  // the proximity terms that are actually anchored — a bare literal in ORDER BY
  // is read by Postgres as an (invalid) column ordinal, so never emit one.
  const orderBy: SQL[] = [];
  if (hasAmount) {
    orderBy.push(asc(sql`ABS((${stagedPayments.amount})::numeric - ${amt})`));
  }
  if (opts.date) {
    orderBy.push(asc(sql`ABS(${stagedPayments.dateReceived} - ${opts.date}::date)`));
  }
  orderBy.push(desc(stagedPayments.dateReceived));

  const [row] = await db
    .select({
      stagedPaymentId: stagedPayments.id,
      payerName: stagedPayments.payerName,
      amount: stagedPayments.amount,
      dateReceived: stagedPayments.dateReceived,
      paymentMethod: stagedPayments.qbPaymentMethod,
      reference: stagedPayments.rawReference,
    })
    .from(stagedPayments)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(1);

  if (!row) return null;
  return {
    source: "quickbooks",
    stagedPaymentId: row.stagedPaymentId,
    stripeChargeId: null,
    payerName: row.payerName,
    amount: row.amount,
    dateReceived: row.dateReceived,
    paymentMethod: row.paymentMethod,
    reference: row.reference,
  };
}

// Best-guess UNLINKED Stripe staged charge for a stray gift row — the Stripe
// analogue of proposeQbPaymentForGift, used when no plausible QuickBooks payment
// exists (a Stripe-settled gift never gets a per-gift QB record). Restricted to
// still-open charges not yet tied to a gift (status='pending', matched/created
// gift both null) and not refunded/disputed (those aren't real gifts). The
// amount uses the shared KNOWN-NET fee band (giftMatchAmountBoundsKnownNet): a
// gift booked anywhere in [min(net,gross), max(net,gross)] is the same money a
// processor fee apart, consistent with how the reconciler ties a charge (GROSS)
// to a gift. Ordered so the closest-gross, then closest-date row wins.
async function proposeStripeChargeForGift(opts: {
  rawDonorName: string | null;
  amount: string | null;
  date: string | null;
}): Promise<ProposedPayment | null> {
  const amt =
    opts.amount != null && opts.amount !== "" ? Number(opts.amount) : NaN;
  const hasAmount = Number.isFinite(amt) && amt > 0;
  const name = (opts.rawDonorName ?? "").trim();
  const hasText = name.length >= 2;
  if (!hasText && !hasAmount) return null;

  const conds: SQL[] = [
    // DERIVED pending: no exclusion, no gift link (lib/derivedStatus.ts).
    chargeStatusWhere.pending,
    sql`${stripeStagedCharges.matchedGiftId} IS NULL`,
    sql`${stripeStagedCharges.createdGiftId} IS NULL`,
    eq(stripeStagedCharges.refunded, false),
    eq(stripeStagedCharges.disputed, false),
  ];
  if (hasText) conds.push(stripeChargeSearchWhere(name));
  if (hasAmount) {
    // Gross must be known for the fee band to mean anything; LEAST/GREATEST
    // ignore a NULL net and collapse to a near-exact gross window (safe).
    conds.push(sql`${stripeStagedCharges.grossAmount} IS NOT NULL`);
    conds.push(
      giftMatchAmountBoundsKnownNet(
        sql`${amt}`,
        sql`(${stripeStagedCharges.grossAmount})::numeric`,
        sql`(${stripeStagedCharges.netAmount})::numeric`,
      ),
    );
  }
  if (opts.date) {
    // A charge already tied to a QuickBooks deposit by a confirmed settlement
    // link (linkedQbStagedPaymentId) is authoritative context — the human
    // confirmed this money settled through QB. Never let the ±30d window hide
    // it: a gift is routinely booked well after (or before) the charge date.
    conds.push(
      sql`(${stripeStagedCharges.linkedQbStagedPaymentId} IS NOT NULL OR (${stripeStagedCharges.dateReceived} IS NOT NULL AND ${stripeStagedCharges.dateReceived} BETWEEN (${opts.date}::date - 30) AND (${opts.date}::date + 30)))`,
    );
  }

  const orderBy: SQL[] = [
    // Settlement-tied charges first — the confirmed payout↔deposit link is
    // stronger evidence than raw amount/date proximity.
    desc(sql`(${stripeStagedCharges.linkedQbStagedPaymentId} IS NOT NULL)`),
  ];
  if (hasAmount) {
    orderBy.push(
      asc(sql`ABS((${stripeStagedCharges.grossAmount})::numeric - ${amt})`),
    );
  }
  if (opts.date) {
    orderBy.push(
      asc(sql`ABS(${stripeStagedCharges.dateReceived} - ${opts.date}::date)`),
    );
  }
  orderBy.push(desc(stripeStagedCharges.dateReceived));

  const [row] = await db
    .select({
      stripeChargeId: stripeStagedCharges.id,
      payerName: sql<string | null>`COALESCE(
        NULLIF(TRIM(${stripeStagedCharges.payerName}), ''),
        NULLIF(TRIM(${stripeStagedCharges.description}), '')
      )`,
      amount: stripeStagedCharges.grossAmount,
      dateReceived: stripeStagedCharges.dateReceived,
      paymentMethod: stripeStagedCharges.cardBrand,
      reference: sql<string | null>`COALESCE(
        NULLIF(TRIM(${stripeStagedCharges.description}), ''),
        NULLIF(TRIM(${stripeStagedCharges.statementDescriptor}), '')
      )`,
    })
    .from(stripeStagedCharges)
    .where(and(...conds))
    .orderBy(...orderBy)
    .limit(1);

  if (!row) return null;
  return {
    source: "stripe",
    stagedPaymentId: null,
    stripeChargeId: row.stripeChargeId,
    payerName: row.payerName,
    amount: row.amount,
    dateReceived: row.dateReceived,
    paymentMethod: row.paymentMethod,
    reference: row.reference,
  };
}

// One-click proposal for a stray gift row. Prefer a QuickBooks staged payment
// (invariant: every gift should eventually have a QB record); fall back to an
// unlinked Stripe charge when no plausible QB payment exists so Stripe-settled
// gifts — which never get a per-gift QB record — can still be linked in one
// click. Returns null when neither source has a plausible match.
async function proposePaymentForGift(opts: {
  rawDonorName: string | null;
  amount: string | null;
  date: string | null;
}): Promise<ProposedPayment | null> {
  const qb = await proposeQbPaymentForGift(opts);
  if (qb) return qb;
  return proposeStripeChargeForGift(opts);
}

// ─── Funding-source filter (correlated EXISTS) ──────────────────────────────
// The fundingSource query param slices the worklist by the SOURCE of each row's
// best-guess UNLINKED payment proposal (the same match the row's one-click Link
// surfaces). Because the proposal is computed per-page in JS (proposePaymentForGift),
// filtering it server-side — before pagination — needs the same matching logic as a
// correlated EXISTS. These two builders MUST stay in lockstep with
// proposeQbPaymentForGift / proposeStripeChargeForGift above (same gate, same
// name/amount/date bands); if one changes, change the other or the filter and the
// displayed proposal will disagree. `name` / `amount` / `date` are per-row SQL
// expressions from the outer query (donor name, search amount, display date).

// TRUE when at least one still-unlinked QuickBooks staged payment plausibly
// matches this gift row → the row's proposal would be a QuickBooks payment.
function qbProposalExistsSql(name: SQL, amount: SQL, date: SQL): SQL {
  const namePattern = sql`('%' || ${name} || '%')`;
  const hasText = sql`char_length(trim(COALESCE(${name}, ''))) >= 2`;
  const hasAmount = sql`(${amount} IS NOT NULL AND ${amount} > 0)`;
  return sql`(
    (${hasText} OR ${hasAmount})
    AND EXISTS (
      SELECT 1 FROM ${stagedPayments}
      WHERE ${stagedPayments.matchedGiftId} IS NULL
        AND ${stagedPayments.createdGiftId} IS NULL
        AND ${stagedPayments.groupReconciledGiftId} IS NULL
        AND ${stagedStatusWhere.pending}
        AND (NOT ${hasText} OR (${stagedSearchWhereExpr(namePattern)}))
        AND (NOT ${hasAmount} OR (
          ${stagedPayments.amount} IS NOT NULL
          AND (${stagedPayments.amount})::numeric
              BETWEEN LEAST(${amount} * 0.8, ${amount} - 50)
                  AND GREATEST(${amount} * 1.2, ${amount} + 50)
        ))
        AND (${date} IS NULL OR (
          ${stagedPayments.dateReceived} IS NOT NULL
          AND ${stagedPayments.dateReceived}
              BETWEEN ((${date})::date - 30) AND ((${date})::date + 30)
        ))
    )
  )`;
}

// TRUE when at least one still-open, unlinked Stripe charge plausibly matches
// this gift row. A row's proposal is Stripe only when NO QuickBooks payment
// matches (QB is preferred), so callers pair this with NOT qbProposalExistsSql.
function stripeProposalExistsSql(name: SQL, amount: SQL, date: SQL): SQL {
  const namePattern = sql`('%' || ${name} || '%')`;
  const hasText = sql`char_length(trim(COALESCE(${name}, ''))) >= 2`;
  const hasAmount = sql`(${amount} IS NOT NULL AND ${amount} > 0)`;
  return sql`(
    (${hasText} OR ${hasAmount})
    AND EXISTS (
      SELECT 1 FROM ${stripeStagedCharges}
      WHERE ${chargeStatusWhere.pending}
        AND ${stripeStagedCharges.matchedGiftId} IS NULL
        AND ${stripeStagedCharges.createdGiftId} IS NULL
        AND ${stripeStagedCharges.refunded} = false
        AND ${stripeStagedCharges.disputed} = false
        AND (NOT ${hasText} OR (${stripeChargeSearchWhereExpr(namePattern)}))
        AND (NOT ${hasAmount} OR (
          ${stripeStagedCharges.grossAmount} IS NOT NULL
          AND ${giftMatchAmountBoundsKnownNet(
            sql`${amount}`,
            sql`(${stripeStagedCharges.grossAmount})::numeric`,
            sql`(${stripeStagedCharges.netAmount})::numeric`,
          )}
        ))
        AND (${date} IS NULL
          OR ${stripeStagedCharges.linkedQbStagedPaymentId} IS NOT NULL
          OR (
          ${stripeStagedCharges.dateReceived} IS NOT NULL
          AND ${stripeStagedCharges.dateReceived}
              BETWEEN ((${date})::date - 30) AND ((${date})::date + 30)
        ))
    )
  )`;
}

// ─── GET /reconciliation/gifts-missing-qb ──────────────────────────────────
// The "gifts with no QuickBooks record" stray worklist. Because the main
// reconciliation queue is QB-anchored (one card per QB money event), a gift that
// no QB staged row ever linked to — and that carries no QB final-amount pointer —
// falls through it. User invariant: EVERY gift should eventually have a QB record;
// only SOME (card/online) should ALSO have Stripe. So this list surfaces gifts
// that are missing their QB record for human follow-up. Broad + filterable;
// read-only (no mutation). Donor names are masked per the viewer, same as the
// other list endpoints (match RAW name, mask DISPLAY).
router.get(
  "/reconciliation/gifts-missing-qb",
  asyncHandler(async (req, res) => {
    const viewer = getViewer(req);
    const q = (typeof req.query["q"] === "string" ? req.query["q"] : "").trim();
    const entityId =
      typeof req.query["entityId"] === "string" ? req.query["entityId"] : null;
    const paymentMethodRaw =
      typeof req.query["paymentMethod"] === "string"
        ? req.query["paymentMethod"]
        : null;
    const paymentMethod =
      paymentMethodRaw && PAYMENT_METHODS.has(paymentMethodRaw)
        ? paymentMethodRaw
        : null;
    const fundingSourceRaw =
      typeof req.query["fundingSource"] === "string"
        ? req.query["fundingSource"]
        : null;
    const fundingSource =
      fundingSourceRaw === "stripe" ||
      fundingSourceRaw === "donorbox" ||
      fundingSourceRaw === "qb_direct"
        ? fundingSourceRaw
        : null;
    const dateFrom =
      typeof req.query["dateFrom"] === "string" ? req.query["dateFrom"] : null;
    const dateTo =
      typeof req.query["dateTo"] === "string" ? req.query["dateTo"] : null;
    if (dateFrom && !isValidIsoDate(dateFrom)) {
      res
        .status(400)
        .json({ error: "dateFrom must be a valid YYYY-MM-DD date." });
      return;
    }
    if (dateTo && !isValidIsoDate(dateTo)) {
      res.status(400).json({ error: "dateTo must be a valid YYYY-MM-DD date." });
      return;
    }
    const limit = clampInt(req.query["limit"], 50, 1, 200);
    const offset = clampInt(req.query["offset"], 0, 0, 1_000_000);

    // "Missing a QuickBooks record": the gift has no QuickBooks cash-application
    // ledger row (T003 cutover — the authoritative QB-link signal). The legacy
    // final-amount pointer + scattered staged_payments linkage is subsumed by the
    // ledger (every such pointer is backfilled into a ledger row; the parity gate
    // blocks the cutover on any final-amount pointer with no ledger row).
    const noQbRecord = sql`NOT ${qbLedgerExistsForGift()}`;

    // A gift is settled through a non-QB processor when it has a COUNTED Stripe or
    // Donorbox cash-application ledger row (T003 cutover — the authoritative link
    // signal, replacing the legacy final-amount pointer + staged_charges.matched_gift_id
    // reads). Such money lands in QuickBooks at the PAYOUT level, not per gift, so the
    // gift never gets a per-gift QB ledger link — it is effectively reconciled, NOT a
    // "missing QB record". Excluding it keeps this worklist an exact mirror of
    // deriveGiftQbTie's "missing" (on-books gift with NO counted evidence of ANY
    // source), so the queue never lists a gift the tie badge already calls tied.
    const isProcessorSettledSql = sql<boolean>`(
      ${stripeLedgerExistsForGift()}
      OR ${donorboxLedgerExistsForGift()}
    )`;

    // Membership = genuinely UN-reconciled, on-books gift ALLOCATIONS only. One
    // row per gift_allocation (gifts with no allocation surface a single row with
    // a null allocation). A row is listed when:
    //   • the gift has no QuickBooks cash-application ledger row (noQbRecord), AND
    //   • the gift is NOT Stripe-tied (reconciled at the payout level), AND
    //   • the allocation is NOT attributed to an entity that never settles through
    //     a payment processor (entities.expects_payment = false: "Direct to School"
    //     / "Wildflower Foundation TSNE"). Gifts with no allocation, and allocations
    //     with no entity, are kept.
    // This mirrors deriveGiftQbTie's "missing" status at allocation granularity, so
    // the queue never lists money that is exempt or tied as if it were unreconciled.
    const conds: SQL[] = [
      isNull(giftsAndPayments.archivedAt),
      // A gift explicitly parked as awaiting settlement (a won gift booked ahead
      // of its imminent payment) is not yet expected to carry a QB record, so it
      // must not surface here as if it were an un-reconciled data-quality miss.
      sql`NOT ${giftsAndPayments.awaitingSettlement}`,
      noQbRecord,
      sql`NOT ${isProcessorSettledSql}`,
      sql`(${giftAllocations.id} IS NULL OR ${giftAllocations.entityId} IS NULL OR COALESCE(${entities.expectsPayment}, true) = true)`,
      // Reimbursement grants are PLEDGES: each real QuickBooks / Stripe check is
      // booked as its own 1:1 gift payment on the award pledge (via the "Record as
      // a payment on a pledge" resolve action → create_gift_from_opportunity), so
      // their gifts do NOT tie to QuickBooks the usual per-gift way. Exclude any
      // gift whose opportunity carries a reimbursable pledge allocation so it never
      // surfaces here as a data-quality miss. (Null opportunityId → EXISTS false →
      // the gift is kept.)
      sql`NOT ${reimbursablePledgeExistsSql(sql`${giftsAndPayments.opportunityId}`)}`,
    ];

    if (q.length >= 2) {
      const like = `%${escapeLike(q)}%`;
      conds.push(
        or(
          ilike(organizations.name, like),
          ilike(people.fullName, like),
          sql`TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})) ILIKE ${like}`,
          ilike(households.name, like),
          // Also match the CRM gift's own name, so a gift can be found even
          // when the searcher doesn't know (or isn't searching by) the donor.
          ilike(giftsAndPayments.name, like),
        )!,
      );
    }
    if (entityId) {
      // Per-allocation: only the rows attributed to this entity surface.
      conds.push(eq(giftAllocations.entityId, entityId));
    }
    if (paymentMethod) {
      conds.push(sql`${giftsAndPayments.paymentMethod} = ${paymentMethod}`);
    }
    if (dateFrom) {
      conds.push(sql`${giftsAndPayments.dateReceived} >= ${dateFrom}::date`);
    }
    if (dateTo) {
      conds.push(sql`${giftsAndPayments.dateReceived} <= ${dateTo}::date`);
    }

    // Funding-source filter: slice by the SOURCE of the row's best-guess unlinked
    // payment proposal. These per-row expressions mirror what proposePaymentForGift
    // is fed in JS (raw donor name / search amount / display date), so the EXISTS
    // predicates below agree with the proposal each row would actually surface.
    if (fundingSource) {
      const rawDonorNameSql = sql`COALESCE(${organizations.name}, ${personNameSql}, ${households.name})`;
      const searchAmountSql = sql`COALESCE(
        ${giftAllocations.subAmount},
        ${giftsAndPayments.amount},
        (
          SELECT NULLIF(SUM(ga.sub_amount), 0)
          FROM ${giftAllocations} ga
          WHERE ga.gift_id = ${giftsAndPayments.id}
        )
      )::numeric`;
      const searchDateSql = sql`COALESCE(
        ${giftsAndPayments.dateReceived},
        (
          SELECT MIN(ga.spending_start)
          FROM ${giftAllocations} ga
          WHERE ga.gift_id = ${giftsAndPayments.id}
        )
      )`;
      const qbExists = qbProposalExistsSql(
        rawDonorNameSql,
        searchAmountSql,
        searchDateSql,
      );
      if (fundingSource === "qb_direct") {
        conds.push(qbExists);
      } else if (fundingSource === "stripe") {
        // QuickBooks is preferred, so a Stripe proposal only wins when NO QB
        // payment matches.
        const stripeExists = stripeProposalExistsSql(
          rawDonorNameSql,
          searchAmountSql,
          searchDateSql,
        );
        conds.push(sql`(NOT ${qbExists} AND ${stripeExists})`);
      } else {
        // Donorbox settles through Stripe and never originates a proposal here, so
        // this filter yields no rows (kept only for parity with the other columns).
        conds.push(sql`1 = 0`);
      }
    }

    const where = and(...conds);

    // Amount/date to DISPLAY (gift-header context, repeated across the gift's
    // allocation rows). The header amount/date_received can be null on imported or
    // grant records; fall back to allocation data so the row shows meaningful
    // values when the gift has them. Amount → sum of allocation sub-amounts; date →
    // earliest allocation spending-start. Both stay null only when no value exists
    // anywhere. These are read-only display fields; they feed no financial total.
    const displayAmountSql = sql<string | null>`COALESCE(
      ${giftsAndPayments.amount},
      (
        SELECT NULLIF(SUM(ga.sub_amount), 0)
        FROM ${giftAllocations} ga
        WHERE ga.gift_id = ${giftsAndPayments.id}
      )
    )::text`;
    const displayDateSql = sql<string | null>`COALESCE(
      ${giftsAndPayments.dateReceived},
      (
        SELECT MIN(ga.spending_start)
        FROM ${giftAllocations} ga
        WHERE ga.gift_id = ${giftsAndPayments.id}
      )
    )`;

    // Companion "already linked" matches (q-search only). The worklist by
    // definition EXCLUDES gifts already tied to money, so a text search for one
    // finds nothing and reads as "the gift doesn't exist". Surface up to 10
    // text-matching gifts that are excluded BECAUSE they're linked (QB ledger row,
    // or settled through Stripe/Donorbox) so the UI can gray them out with a note —
    // mirroring the payment-side gift search. Gift-level (not per-allocation),
    // text filter only: the other facets (entity/method/date) slice the WORKLIST,
    // while this is a "did I miss it?" lookup.
    const linkedMatchesPromise =
      q.length >= 2
        ? (() => {
            const like = `%${escapeLike(q)}%`;
            return db
              .select({
                id: giftsAndPayments.id,
                giftName: giftsAndPayments.name,
                amount: displayAmountSql,
                dateReceived: giftsAndPayments.dateReceived,
                hasQbLedger: sql<boolean>`${qbLedgerExistsForGift()}`,
                organizationId: giftsAndPayments.organizationId,
                individualGiverPersonId:
                  giftsAndPayments.individualGiverPersonId,
                householdId: giftsAndPayments.householdId,
                organizationName: organizations.name,
                organizationAnonymous: organizations.anonymous,
                organizationOwnerUserId: organizations.ownerUserId,
                personName: personNameSql,
                personAnonymous: people.anonymous,
                personOwnerUserId: people.ownerUserId,
                householdName: households.name,
              })
              .from(giftsAndPayments)
              .leftJoin(
                organizations,
                eq(organizations.id, giftsAndPayments.organizationId),
              )
              .leftJoin(
                people,
                eq(people.id, giftsAndPayments.individualGiverPersonId),
              )
              .leftJoin(
                households,
                eq(households.id, giftsAndPayments.householdId),
              )
              .where(
                and(
                  isNull(giftsAndPayments.archivedAt),
                  or(
                    ilike(organizations.name, like),
                    ilike(people.fullName, like),
                    sql`TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})) ILIKE ${like}`,
                    ilike(households.name, like),
                    ilike(giftsAndPayments.name, like),
                  )!,
                  sql`(${qbLedgerExistsForGift()} OR ${isProcessorSettledSql})`,
                ),
              )
              .orderBy(
                desc(giftsAndPayments.dateReceived),
                desc(giftsAndPayments.id),
              )
              .limit(10);
          })()
        : Promise.resolve(null);

    // The driving table is gift_allocations (LEFT-joined onto gifts so a gift with
    // no allocation still surfaces one row). Entity / fundable-project / school are
    // the ALLOCATION's own scope. Keep the list and count queries in lockstep at
    // this allocation-row granularity.
    const [rows, totalRow, linkedRows] = await Promise.all([
      db
        .select({
          id: giftsAndPayments.id,
          giftName: giftsAndPayments.name,
          allocationId: giftAllocations.id,
          allocationAmount: giftAllocations.subAmount,
          intendedUsage: giftAllocations.intendedUsage,
          displayUsage: giftAllocations.displayUsage,
          fundableProjectId: giftAllocations.fundableProjectId,
          fundableProjectName: fundableProjects.name,
          schoolRecipientId: giftAllocations.schoolRecipientId,
          schoolRecipientName: schools.name,
          grantYear: giftAllocations.grantYear,
          amount: giftsAndPayments.amount,
          displayAmount: displayAmountSql,
          dateReceived: giftsAndPayments.dateReceived,
          displayDate: displayDateSql,
          paymentMethod: giftsAndPayments.paymentMethod,
          finalAmountSource: giftsAndPayments.finalAmountSource,
          opportunityId: giftsAndPayments.opportunityId,
          opportunityName: opportunitiesAndPledges.name,
          organizationId: giftsAndPayments.organizationId,
          individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
          householdId: giftsAndPayments.householdId,
          organizationName: organizations.name,
          organizationAnonymous: organizations.anonymous,
          organizationOwnerUserId: organizations.ownerUserId,
          personName: personNameSql,
          personAnonymous: people.anonymous,
          personOwnerUserId: people.ownerUserId,
          householdName: households.name,
          entityId: giftAllocations.entityId,
          entityName: entities.name,
        })
        .from(giftsAndPayments)
        .leftJoin(
          giftAllocations,
          eq(giftAllocations.giftId, giftsAndPayments.id),
        )
        .leftJoin(entities, eq(entities.id, giftAllocations.entityId))
        .leftJoin(
          fundableProjects,
          eq(fundableProjects.id, giftAllocations.fundableProjectId),
        )
        .leftJoin(schools, eq(schools.id, giftAllocations.schoolRecipientId))
        .leftJoin(
          organizations,
          eq(organizations.id, giftsAndPayments.organizationId),
        )
        .leftJoin(
          people,
          eq(people.id, giftsAndPayments.individualGiverPersonId),
        )
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(
          opportunitiesAndPledges,
          eq(opportunitiesAndPledges.id, giftsAndPayments.opportunityId),
        )
        .where(where)
        .orderBy(
          desc(giftsAndPayments.dateReceived),
          desc(giftsAndPayments.id),
          asc(giftAllocations.id),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(giftsAndPayments)
        .leftJoin(
          giftAllocations,
          eq(giftAllocations.giftId, giftsAndPayments.id),
        )
        .leftJoin(entities, eq(entities.id, giftAllocations.entityId))
        .leftJoin(
          organizations,
          eq(organizations.id, giftsAndPayments.organizationId),
        )
        .leftJoin(
          people,
          eq(people.id, giftsAndPayments.individualGiverPersonId),
        )
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .where(where)
        .then((r) => r[0]),
      linkedMatchesPromise,
    ]);

    // Mask donor names on the linked matches exactly like the main rows.
    const linkedMatches = linkedRows?.map((r) => {
      let donorName: string | null = null;
      let donorKind: "organization" | "person" | "household" | null = null;
      if (r.organizationId) {
        donorKind = "organization";
        donorName = maskName(
          r.organizationName,
          {
            anonymous: r.organizationAnonymous,
            ownerUserId: r.organizationOwnerUserId,
          },
          viewer,
        );
      } else if (r.individualGiverPersonId) {
        donorKind = "person";
        donorName = maskName(
          r.personName,
          { anonymous: r.personAnonymous, ownerUserId: r.personOwnerUserId },
          viewer,
        );
      } else if (r.householdId) {
        donorKind = "household";
        donorName = r.householdName;
      }
      return {
        id: r.id,
        giftName: r.giftName,
        donorName,
        donorKind,
        amount: r.amount,
        dateReceived: r.dateReceived,
        linkedVia: r.hasQbLedger ? ("quickbooks" as const) : ("processor" as const),
      };
    });

    const base = rows.map((r) => {
      let donorName: string | null = null;
      let donorKind: "organization" | "person" | "household" | null = null;
      // RAW (unmasked) donor name — used only to search for a proposed payment
      // (server-side), never returned; the returned donorName stays masked.
      let rawDonorName: string | null = null;
      if (r.organizationId) {
        donorKind = "organization";
        rawDonorName = r.organizationName;
        donorName = maskName(
          r.organizationName,
          {
            anonymous: r.organizationAnonymous,
            ownerUserId: r.organizationOwnerUserId,
          },
          viewer,
        );
      } else if (r.individualGiverPersonId) {
        donorKind = "person";
        rawDonorName = r.personName;
        donorName = maskName(
          r.personName,
          {
            anonymous: r.personAnonymous,
            ownerUserId: r.personOwnerUserId,
          },
          viewer,
        );
      } else if (r.householdId) {
        donorKind = "household";
        rawDonorName = r.householdName;
        donorName = r.householdName;
      }
      return {
        rawDonorName,
        row: {
          id: r.id,
          rowKey: `${r.id}:${r.allocationId ?? "none"}`,
          allocationId: r.allocationId,
          giftName: r.giftName,
          donorName,
          donorKind,
          amount: r.amount,
          displayAmount: r.displayAmount,
          allocationAmount: r.allocationAmount,
          dateReceived: r.dateReceived,
          displayDate: r.displayDate,
          paymentMethod: r.paymentMethod,
          entityId: r.entityId,
          entityName: r.entityName,
          intendedUsage: r.intendedUsage,
          displayUsage: r.displayUsage,
          fundableProjectId: r.fundableProjectId,
          fundableProjectName: r.fundableProjectName,
          schoolRecipientId: r.schoolRecipientId,
          schoolRecipientName: r.schoolRecipientName,
          grantYear: r.grantYear,
          finalAmountSource: r.finalAmountSource,
          opportunityId: r.opportunityId,
          opportunityName: r.opportunityName,
        },
      };
    });

    // Attach a proposed unlinked QB payment per row (page-scoped, ≤ limit rows).
    // Rows that share the same (donor, amount, date) reuse one lookup so a
    // multi-allocation gift doesn't re-run the same query.
    const proposalCache = new Map<
      string,
      Promise<ProposedPayment | null>
    >();
    const data = await Promise.all(
      base.map(async ({ rawDonorName, row }) => {
        const searchAmount = row.allocationAmount ?? row.displayAmount ?? null;
        const cacheKey = `${rawDonorName ?? ""}|${searchAmount ?? ""}|${row.displayDate ?? ""}`;
        let pending = proposalCache.get(cacheKey);
        if (!pending) {
          pending = proposePaymentForGift({
            rawDonorName,
            amount: searchAmount,
            date: row.displayDate,
          });
          proposalCache.set(cacheKey, pending);
        }
        return { ...row, proposedPayment: await pending };
      }),
    );

    res.json({
      data,
      ...(linkedMatches ? { linkedMatches } : {}),
      pagination: {
        page: Math.floor(offset / limit) + 1,
        limit,
        total: totalRow?.value ?? 0,
      },
    });
  }),
);

export default router;
