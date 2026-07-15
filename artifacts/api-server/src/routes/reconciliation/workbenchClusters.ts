import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { asyncHandler, parsePagination } from "../../lib/helpers";
import { getViewer, maskName, type Viewer } from "../../lib/identityVisibility";
import { escapeLike } from "../quickbooks/shared";
import { reimbursablePledgeExistsSql } from "../../lib/reimbursablePlaceholder";
import { fullyChargeTied } from "./bundleAnchors";

// ─── GET /reconciliation/workbench-clusters ─────────────────────────────────
//
// ONE unified, paginated list of reconciliation CLUSTERS — each row a
// self-contained unit of money work carrying all three facets (CRM gifts,
// transaction evidence, bank & accounting records). Three kinds partition the
// universe (money-safety mirrors the bundle-anchor omission rules):
//
//   stripe_payout — a payout with its charges, per-charge gift links, the
//                   settlement-linked QB deposit and linked fee/tie QB rows.
//   qb_standalone — a QB staged row with no payout/settlement/charge/fee tie;
//                   a unit-group representative carries the whole group.
//   crm_only      — an on-books gift with NO counted QB or Stripe ledger row
//                   (Donorbox-only is fine — renders as a badge, not evidence).
//
// Two-pass shape: a slim UNION computes per-cluster lens flags for the whole
// universe (rail counts + page selection), then only the page's clusters are
// hydrated per kind. Read-only — no actions here.

const router: IRouter = Router();

const LENSES = [
  "all_open",
  "needs_donor_or_gift",
  "needs_accounting",
  "conflicts",
  "refunds",
  "excluded",
  "completed",
] as const;
type Lens = (typeof LENSES)[number];

// WHERE predicate over the slim flag columns, per lens.
const LENS_PREDICATE: Record<Lens, string> = {
  all_open: "(NOT f_completed AND NOT f_excluded)",
  needs_donor_or_gift: "f_needs_gift",
  needs_accounting: "f_needs_acct",
  conflicts: "f_conflict",
  refunds: "f_refund",
  excluded: "f_excluded",
  completed: "f_completed",
};

/* ── alias-local derived-status fragments (raw strings, static aliases) ────
 * These mirror lib/derivedStatus.ts EXACTLY but take an alias name, because
 * the shared fragments reference the base tables and render unqualified
 * inside alias()d/raw joins (drizzle footgun). Any change to the status
 * derivation must land in BOTH places. */

const qbCounted = (a: string) =>
  `EXISTS (SELECT 1 FROM payment_applications pa_q WHERE pa_q.payment_id = ${a}.id AND pa_q.link_role = 'counted')`;
const qbDepositSettled = (a: string) =>
  `EXISTS (SELECT 1 FROM settlement_links sl_q WHERE sl_q.deposit_staged_payment_id = ${a}.id AND sl_q.lifecycle = 'confirmed')`;
const qbStatusCase = (a: string) => `(CASE
  WHEN ${a}.exclusion_reason IS NOT NULL THEN 'excluded'
  WHEN ${a}.auto_applied = true AND ${a}.match_confirmed_at IS NULL AND ${qbCounted(a)} THEN 'match_proposed'
  WHEN ${qbCounted(a)} OR ${qbDepositSettled(a)} THEN 'match_confirmed'
  ELSE 'pending'
END)`;
/** Open = pending OR match_proposed (still needs donor/gift work). */
const qbOpen = (a: string) => `(${a}.exclusion_reason IS NULL AND (
  NOT (${qbCounted(a)} OR ${qbDepositSettled(a)})
  OR (${a}.auto_applied = true AND ${a}.match_confirmed_at IS NULL AND ${qbCounted(a)})
))`;

const chCounted = (a: string) =>
  `EXISTS (SELECT 1 FROM payment_applications pa_s WHERE pa_s.stripe_charge_id = ${a}.id AND pa_s.evidence_source = 'stripe' AND pa_s.link_role = 'counted')`;
const chStatusCase = (a: string) => `(CASE
  WHEN ${a}.exclusion_reason IS NOT NULL THEN 'excluded'
  WHEN ${a}.auto_applied = true AND ${a}.match_confirmed_at IS NULL AND ${chCounted(a)} THEN 'match_proposed'
  WHEN ${chCounted(a)} THEN 'match_confirmed'
  ELSE 'pending'
END)`;
const chOpen = (a: string) => `(${a}.exclusion_reason IS NULL AND (
  NOT ${chCounted(a)}
  OR (${a}.auto_applied = true AND ${a}.match_confirmed_at IS NULL)
))`;
const chConfirmed = (a: string) =>
  `(${a}.exclusion_reason IS NULL AND ${chCounted(a)} AND NOT (${a}.auto_applied = true AND ${a}.match_confirmed_at IS NULL))`;

/** Canonical person display-name chain (alias-local twin of personDisplayNameSql). */
const personNameExpr = (a: string) => `COALESCE(
  CASE WHEN NULLIF(TRIM(${a}.nickname), '') IS NOT NULL
       THEN NULLIF(TRIM(CONCAT_WS(' ', ${a}.nickname, ${a}.last_name)), '') END,
  NULLIF(TRIM(${a}.full_name), ''),
  NULLIF(TRIM(CONCAT_WS(' ', ${a}.first_name, ${a}.last_name)), '')
)`;

/** Donor projection for a gifts_and_payments alias g joined to o/p/h. */
const donorFields = `
  CASE WHEN g.organization_id IS NOT NULL THEN 'organization'
       WHEN g.individual_giver_person_id IS NOT NULL THEN 'person'
       WHEN g.household_id IS NOT NULL THEN 'household' END AS donor_kind,
  COALESCE(g.organization_id, g.individual_giver_person_id, g.household_id) AS donor_id,
  COALESCE(o.name, h.name, ${personNameExpr("p")}) AS donor_name,
  COALESCE(o.anonymous, p.anonymous, false) AS donor_anonymous,
  COALESCE(o.owner_user_id, p.owner_user_id) AS donor_owner_user_id`;

const donorJoins = `
  LEFT JOIN organizations o ON o.id = g.organization_id
  LEFT JOIN people p ON p.id = g.individual_giver_person_id
  LEFT JOIN households h ON h.id = g.household_id`;

const donorboxBacked = `EXISTS (
  SELECT 1 FROM payment_applications pa_d
  WHERE pa_d.gift_id = g.id AND pa_d.evidence_source = 'donorbox' AND pa_d.link_role = 'counted'
)`;

/* ── slim universe (lens flags only) ───────────────────────────────────── */

// stripe_payout half — per-payout rollup predicates.
const payoutAnyOpenCharge = `EXISTS (
  SELECT 1 FROM stripe_staged_charges oc
  WHERE oc.stripe_payout_id = sp.id AND ${chOpen("oc")}
)`;
const payoutHasCharges = `EXISTS (SELECT 1 FROM stripe_staged_charges hc WHERE hc.stripe_payout_id = sp.id)`;
const payoutHasNonExcluded = `EXISTS (SELECT 1 FROM stripe_staged_charges nc WHERE nc.stripe_payout_id = sp.id AND nc.exclusion_reason IS NULL)`;
const payoutAllExcluded = `(${payoutHasCharges} AND NOT ${payoutHasNonExcluded})`;
const payoutConflict = `EXISTS (
  SELECT 1 FROM settlement_links sl_c
  WHERE sl_c.payout_id = sp.id AND sl_c.lifecycle = 'proposed' AND sl_c.conflict_gift_id IS NOT NULL
)`;
const payoutRefund = `EXISTS (
  SELECT 1 FROM stripe_staged_charges rf
  WHERE rf.stripe_payout_id = sp.id AND rf.refund_propagation_status = 'proposed'
)`;
// Settled = a confirmed settlement link OR the individually-booked
// fully-charge-tied path (shared fragment; alias sp — matches this FROM).
const payoutSettled: SQL = sql`(EXISTS (
  SELECT 1 FROM settlement_links sl_s
  WHERE sl_s.payout_id = sp.id AND sl_s.lifecycle = 'confirmed'
) OR ${fullyChargeTied})`;

// qb_standalone half — eligibility mirrors the bundle-anchor omission rules
// (a settlement-linked deposit, a charge-tied or fee row reconciles THROUGH
// its payout cluster; grouped rows reconcile through their representative).
const qbEligible = `
  NOT EXISTS (SELECT 1 FROM settlement_links sl_e WHERE sl_e.deposit_staged_payment_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM stripe_staged_charges cc_e
    WHERE cc_e.linked_qb_staged_payment_id = s.id OR cc_e.linked_fee_qb_staged_payment_id = s.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM unit_group_members ugm
    WHERE ugm.evidence_source = 'quickbooks' AND ugm.source_id = s.id
      AND ugm.source_id <> (
        SELECT MIN(ugm2.source_id) FROM unit_group_members ugm2
        WHERE ugm2.group_id = ugm.group_id AND ugm2.evidence_source = 'quickbooks'
      )
  )`;
const qbSiblingOpen = `EXISTS (
  SELECT 1 FROM unit_group_members ugm
  JOIN unit_group_members ugm2 ON ugm2.group_id = ugm.group_id AND ugm2.evidence_source = 'quickbooks'
  JOIN staged_payments sm ON sm.id = ugm2.source_id
  WHERE ugm.evidence_source = 'quickbooks' AND ugm.source_id = s.id
    AND sm.id <> s.id AND ${qbOpen("sm")}
)`;
const qbSiblingNonExcluded = `EXISTS (
  SELECT 1 FROM unit_group_members ugm
  JOIN unit_group_members ugm2 ON ugm2.group_id = ugm.group_id AND ugm2.evidence_source = 'quickbooks'
  JOIN staged_payments sm ON sm.id = ugm2.source_id
  WHERE ugm.evidence_source = 'quickbooks' AND ugm.source_id = s.id
    AND sm.id <> s.id AND sm.exclusion_reason IS NULL
)`;
const qbNeedsGift = `(${qbOpen("s")} OR ${qbSiblingOpen})`;
const qbAllExcluded = `(s.exclusion_reason IS NOT NULL AND NOT ${qbSiblingNonExcluded})`;

// crm_only half — an on-books gift with no counted QB/Stripe ledger row.
// Donorbox-only gifts stay (badge); exempt/off-books and reimbursable
// placeholders are omitted; archived and awaiting-settlement gifts too.
const crmEligibleBase = `
  g.archived_at IS NULL
  AND g.awaiting_settlement = false
  AND (g.quickbooks_tie_status IS NULL OR g.quickbooks_tie_status <> 'exempt')
  AND NOT EXISTS (
    SELECT 1 FROM payment_applications pa_g
    WHERE pa_g.gift_id = g.id AND pa_g.link_role = 'counted'
      AND pa_g.evidence_source IN ('quickbooks', 'stripe')
  )`;

function buildUniverse(q: string | null): SQL {
  const like = q ? `%${escapeLike(q)}%` : null;
  const stripeSearch = like
    ? sql` WHERE (sp.id ILIKE ${like} OR EXISTS (
        SELECT 1 FROM stripe_staged_charges qc
        WHERE qc.stripe_payout_id = sp.id
          AND (qc.payer_name ILIKE ${like} OR qc.description ILIKE ${like})
      ))`
    : sql``;
  const qbSearch = like
    ? sql` AND (s.id ILIKE ${like} OR s.payer_name ILIKE ${like} OR s.qb_transaction_memo ILIKE ${like}
        OR s.line_description ILIKE ${like} OR s.raw_reference ILIKE ${like})`
    : sql``;
  const crmSearch = like
    ? sql` AND (g.name ILIKE ${like} OR o.name ILIKE ${like} OR h.name ILIKE ${like}
        OR ${sql.raw(personNameExpr("p"))} ILIKE ${like})`
    : sql``;

  const stripeSlim = sql`
    SELECT
      'stripe_payout'::text AS kind,
      sp.id::text AS anchor_id,
      sp.arrival_date::text AS anchor_date,
      ${sql.raw(payoutAnyOpenCharge)} AS f_needs_gift,
      (NOT ${payoutSettled} AND NOT ${sql.raw(payoutAllExcluded)}) AS f_needs_acct,
      ${sql.raw(payoutConflict)} AS f_conflict,
      ${sql.raw(payoutRefund)} AS f_refund,
      ${sql.raw(payoutAllExcluded)} AS f_excluded,
      (${payoutSettled}
        AND NOT ${sql.raw(payoutAnyOpenCharge)}
        AND NOT ${sql.raw(payoutConflict)}
        AND NOT ${sql.raw(payoutRefund)}
        AND NOT ${sql.raw(payoutAllExcluded)}) AS f_completed
    FROM stripe_payouts sp
    ${stripeSearch}`;

  const qbSlim = sql`
    SELECT
      'qb_standalone'::text AS kind,
      s.id::text AS anchor_id,
      s.date_received::text AS anchor_date,
      ${sql.raw(qbNeedsGift)} AS f_needs_gift,
      false AS f_needs_acct,
      false AS f_conflict,
      false AS f_refund,
      ${sql.raw(qbAllExcluded)} AS f_excluded,
      (NOT ${sql.raw(qbNeedsGift)} AND NOT ${sql.raw(qbAllExcluded)}) AS f_completed
    FROM staged_payments s
    WHERE ${sql.raw(qbEligible)}
    ${qbSearch}`;

  const crmSlim = sql`
    SELECT
      'crm_only'::text AS kind,
      g.id::text AS anchor_id,
      g.date_received::text AS anchor_date,
      false AS f_needs_gift,
      true AS f_needs_acct,
      false AS f_conflict,
      false AS f_refund,
      false AS f_excluded,
      false AS f_completed
    FROM gifts_and_payments g
    ${sql.raw(donorJoins)}
    WHERE ${sql.raw(crmEligibleBase)}
    AND NOT ${reimbursablePledgeExistsSql(sql.raw("g.opportunity_id"))}
    ${crmSearch}`;

  return sql`(${stripeSlim}) UNION ALL (${qbSlim}) UNION ALL (${crmSlim})`;
}

/* ── row types ─────────────────────────────────────────────────────────── */

interface SlimRow {
  kind: "stripe_payout" | "qb_standalone" | "crm_only";
  anchor_id: string;
  anchor_date: string | null;
  f_needs_gift: boolean;
  f_needs_acct: boolean;
  f_conflict: boolean;
  f_refund: boolean;
  f_excluded: boolean;
  f_completed: boolean;
}

interface LensCountsRow {
  all_open: number;
  needs_donor_or_gift: number;
  needs_accounting: number;
  conflicts: number;
  refunds: number;
  excluded: number;
  completed: number;
}

interface ChargeJson {
  chargeId: string;
  payerName: string | null;
  amount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
  chargeDate: string | null;
  status: string;
  linkedGiftId: string | null;
  refundProposed: boolean;
  refundKind: string | null;
}

interface QbRecordJson {
  stagedPaymentId: string;
  role: string;
  reference: string | null;
  lineDescription: string | null;
  memo: string | null;
  amount: string | null;
  dateReceived: string | null;
  status: string;
  linkedChargeId: string | null;
}

interface PayoutRow {
  id: string;
  date: string | null;
  bank_amount: string | null;
  gross_total: string | null;
  fee_total: string | null;
  net_total: string | null;
  charge_count: number | null;
  deposit_payer_name: string | null;
  sl_lifecycle: string | null;
  sl_deposit_id: string | null;
  sl_conflict_gift_id: string | null;
  settled: boolean;
  total_count: number;
  resolved_count: number;
  charges: ChargeJson[];
  linked_qb_rows: QbRecordJson[];
  dep_id: string | null;
  dep_reference: string | null;
  dep_line_description: string | null;
  dep_memo: string | null;
  dep_amount: string | null;
  dep_date: string | null;
  dep_status: string | null;
}

interface GiftRowBase {
  gift_id: string;
  gift_name: string | null;
  amount: string | null;
  date_received: string | null;
  quickbooks_tie: string | null;
  donor_kind: "organization" | "person" | "household" | null;
  donor_id: string | null;
  donor_name: string | null;
  donor_anonymous: boolean;
  donor_owner_user_id: string | null;
  donorbox: boolean;
}

interface PayoutGiftRow extends GiftRowBase {
  payout_id: string;
  charge_id: string;
}

interface QbGiftRow extends GiftRowBase {
  payment_id: string;
}

interface QbAnchorRow {
  id: string;
  date: string | null;
  amount: string | null;
  payer_name: string | null;
  raw_reference: string | null;
  line_description: string | null;
  qb_transaction_memo: string | null;
  status: string;
  group_id: string | null;
  group_member_count: number | null;
  group_total: string | null;
  group_members: QbRecordJson[];
  member_ids: string[] | null;
}

interface CrmGiftRow extends GiftRowBase {
  title_gift_name: string | null;
}

interface GiftOut {
  giftId: string;
  name: string | null;
  donorName: string | null;
  donorKind: string | null;
  donorId: string | null;
  amount: string | null;
  dateReceived: string | null;
  quickbooksTie: string | null;
  donorbox: boolean;
  linkedChargeIds: string[];
  linkedStagedPaymentIds: string[];
}

/* ── JS assembly helpers ───────────────────────────────────────────────── */

function lensesOf(r: SlimRow): Lens[] {
  const out: Lens[] = [];
  if (!r.f_completed && !r.f_excluded) out.push("all_open");
  if (r.f_needs_gift) out.push("needs_donor_or_gift");
  if (r.f_needs_acct) out.push("needs_accounting");
  if (r.f_conflict) out.push("conflicts");
  if (r.f_refund) out.push("refunds");
  if (r.f_excluded) out.push("excluded");
  if (r.f_completed) out.push("completed");
  return out;
}

function statusOf(r: SlimRow, resolvedCount: number | null): string {
  if (r.kind === "crm_only") return "unlinked";
  if (r.f_conflict) return "conflict";
  if (r.f_refund) return "refund";
  if (r.f_excluded) return "excluded";
  if (r.f_completed) return "complete";
  return (resolvedCount ?? 0) > 0 ? "partial" : "unresolved";
}

function giftOut(g: GiftRowBase, viewer: Viewer): GiftOut {
  return {
    giftId: g.gift_id,
    name: g.gift_name,
    donorName: maskName(
      g.donor_name,
      { anonymous: g.donor_anonymous, ownerUserId: g.donor_owner_user_id },
      viewer,
    ),
    donorKind: g.donor_kind,
    donorId: g.donor_id,
    amount: g.amount,
    dateReceived: g.date_received,
    quickbooksTie: g.quickbooks_tie,
    donorbox: g.donorbox,
    linkedChargeIds: [],
    linkedStagedPaymentIds: [],
  };
}

function gapOf(net: string | null, bank: string | null): string | null {
  if (net == null || bank == null) return null;
  const n = Number(net);
  const b = Number(bank);
  if (!Number.isFinite(n) || !Number.isFinite(b)) return null;
  return (n - b).toFixed(2);
}

const QB_STATUS_DETAIL: Record<string, string> = {
  pending: "awaiting donor/gift match",
  match_proposed: "match awaiting confirmation",
  match_confirmed: "matched to a gift",
  excluded: "excluded (not a donation)",
};

/* ── route ─────────────────────────────────────────────────────────────── */

router.get(
  "/reconciliation/workbench-clusters",
  asyncHandler(async (req, res) => {
    const viewer = getViewer(req);
    const rawLens = typeof req.query["lens"] === "string" ? req.query["lens"] : "";
    const lens: Lens = (LENSES as readonly string[]).includes(rawLens)
      ? (rawLens as Lens)
      : "all_open";
    const rawQ = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
    const q = rawQ.length >= 2 ? rawQ : null;
    const { limit, offset, page } = parsePagination({
      limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
      page: req.query["page"] ? Number(req.query["page"]) : undefined,
    });

    const universe = buildUniverse(q);

    const [countsResult, pageResult] = await Promise.all([
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE NOT f_completed AND NOT f_excluded)::int AS all_open,
          count(*) FILTER (WHERE f_needs_gift)::int AS needs_donor_or_gift,
          count(*) FILTER (WHERE f_needs_acct)::int AS needs_accounting,
          count(*) FILTER (WHERE f_conflict)::int AS conflicts,
          count(*) FILTER (WHERE f_refund)::int AS refunds,
          count(*) FILTER (WHERE f_excluded)::int AS excluded,
          count(*) FILTER (WHERE f_completed)::int AS completed
        FROM ( ${universe} ) u`),
      db.execute(sql`
        SELECT kind, anchor_id, anchor_date,
               f_needs_gift, f_needs_acct, f_conflict, f_refund, f_excluded, f_completed
        FROM ( ${universe} ) u
        WHERE ${sql.raw(LENS_PREDICATE[lens])}
        ORDER BY anchor_date DESC NULLS LAST, anchor_id DESC
        LIMIT ${limit} OFFSET ${offset}`),
    ]);

    const lensCounts = (countsResult.rows[0] ?? {
      all_open: 0,
      needs_donor_or_gift: 0,
      needs_accounting: 0,
      conflicts: 0,
      refunds: 0,
      excluded: 0,
      completed: 0,
    }) as unknown as LensCountsRow;
    const slim = pageResult.rows as unknown as SlimRow[];

    const payoutIds = slim.filter((r) => r.kind === "stripe_payout").map((r) => r.anchor_id);
    const qbIds = slim.filter((r) => r.kind === "qb_standalone").map((r) => r.anchor_id);
    const crmIds = slim.filter((r) => r.kind === "crm_only").map((r) => r.anchor_id);

    const inList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

    /* ── hydration (page ids only) ── */

    const payoutRowsP: Promise<PayoutRow[]> = payoutIds.length
      ? db
          .execute(sql`
      SELECT
        sp.id AS id,
        sp.arrival_date::text AS date,
        sp.amount::text AS bank_amount,
        sp.gross_total::text AS gross_total,
        sp.fee_total::text AS fee_total,
        COALESCE(sp.net_total, sp.amount)::text AS net_total,
        sp.charge_count AS charge_count,
        ad.payer_name AS deposit_payer_name,
        sl.lifecycle::text AS sl_lifecycle,
        sl.deposit_staged_payment_id AS sl_deposit_id,
        sl.conflict_gift_id AS sl_conflict_gift_id,
        ${payoutSettled} AS settled,
        (SELECT count(*)::int FROM stripe_staged_charges tc
          WHERE tc.stripe_payout_id = sp.id AND tc.exclusion_reason IS NULL) AS total_count,
        (SELECT count(*)::int FROM stripe_staged_charges vc
          WHERE vc.stripe_payout_id = sp.id AND ${sql.raw(chConfirmed("vc"))}) AS resolved_count,
        COALESCE((
          SELECT json_agg(json_build_object(
              'chargeId', c.id,
              'payerName', c.payer_name,
              'amount', c.amount,
              'feeAmount', c.fee_amount,
              'netAmount', c.net_amount,
              'chargeDate', c.charge_date,
              'status', c.status,
              'linkedGiftId', c.linked_gift_id,
              'refundProposed', c.refund_proposed,
              'refundKind', c.refund_kind
            ) ORDER BY c.gross_num DESC NULLS LAST)
          FROM (
            SELECT cc.id,
                   COALESCE(cc.payer_name, cc.description) AS payer_name,
                   cc.gross_amount::text AS amount,
                   cc.gross_amount AS gross_num,
                   cc.fee_amount::text AS fee_amount,
                   cc.net_amount::text AS net_amount,
                   cc.date_received::text AS charge_date,
                   ${sql.raw(chStatusCase("cc"))} AS status,
                   (SELECT pa_l.gift_id FROM payment_applications pa_l
                     WHERE pa_l.stripe_charge_id = cc.id
                       AND pa_l.evidence_source = 'stripe' AND pa_l.link_role = 'counted'
                     LIMIT 1) AS linked_gift_id,
                   (cc.refund_propagation_status = 'proposed') AS refund_proposed,
                   (CASE WHEN cc.refund_propagation_status = 'proposed'
                         THEN cc.refund_propagation_kind END)::text AS refund_kind
            FROM stripe_staged_charges cc
            WHERE cc.stripe_payout_id = sp.id
            ORDER BY cc.gross_amount DESC NULLS LAST
            LIMIT 50
          ) c
        ), '[]'::json) AS charges,
        COALESCE((
          SELECT json_agg(json_build_object(
              'stagedPaymentId', f.id,
              'role', f.role,
              'reference', f.raw_reference,
              'lineDescription', f.line_description,
              'memo', f.qb_transaction_memo,
              'amount', f.amount,
              'dateReceived', f.date_received,
              'status', f.status,
              'linkedChargeId', f.charge_id
            ))
          FROM (
            SELECT fq.id, 'fee'::text AS role, fq.raw_reference, fq.line_description,
                   fq.qb_transaction_memo, fq.amount::text AS amount,
                   fq.date_received::text AS date_received,
                   ${sql.raw(qbStatusCase("fq"))} AS status, fc.id AS charge_id
            FROM stripe_staged_charges fc
            JOIN staged_payments fq ON fq.id = fc.linked_fee_qb_staged_payment_id
            WHERE fc.stripe_payout_id = sp.id
            UNION ALL
            SELECT tq.id, 'charge_tie'::text, tq.raw_reference, tq.line_description,
                   tq.qb_transaction_memo, tq.amount::text,
                   tq.date_received::text,
                   ${sql.raw(qbStatusCase("tq"))}, tc2.id
            FROM stripe_staged_charges tc2
            JOIN staged_payments tq ON tq.id = tc2.linked_qb_staged_payment_id
            WHERE tc2.stripe_payout_id = sp.id
          ) f
        ), '[]'::json) AS linked_qb_rows,
        ad.id AS dep_id,
        ad.raw_reference AS dep_reference,
        ad.line_description AS dep_line_description,
        ad.qb_transaction_memo AS dep_memo,
        ad.amount::text AS dep_amount,
        ad.date_received::text AS dep_date,
        ${sql.raw(qbStatusCase("ad"))} AS dep_status
      FROM stripe_payouts sp
      LEFT JOIN LATERAL (
        SELECT sl0.lifecycle, sl0.deposit_staged_payment_id, sl0.conflict_gift_id
        FROM settlement_links sl0
        WHERE sl0.payout_id = sp.id
        ORDER BY CASE sl0.lifecycle WHEN 'confirmed' THEN 0 ELSE 1 END
        LIMIT 1
      ) sl ON true
      LEFT JOIN staged_payments ad ON ad.id = sl.deposit_staged_payment_id
      WHERE sp.id IN (${inList(payoutIds)})`)
          .then((r) => r.rows as unknown as PayoutRow[])
      : Promise.resolve([]);

    const payoutGiftsP: Promise<PayoutGiftRow[]> = payoutIds.length
      ? db
          .execute(sql`
      SELECT
        cc.stripe_payout_id AS payout_id,
        cc.id AS charge_id,
        g.id AS gift_id,
        g.name AS gift_name,
        g.amount::text AS amount,
        g.date_received::text AS date_received,
        g.quickbooks_tie_status::text AS quickbooks_tie,
        ${sql.raw(donorFields)},
        ${sql.raw(donorboxBacked)} AS donorbox
      FROM stripe_staged_charges cc
      JOIN payment_applications pa_j ON pa_j.stripe_charge_id = cc.id
        AND pa_j.evidence_source = 'stripe' AND pa_j.link_role = 'counted'
      JOIN gifts_and_payments g ON g.id = pa_j.gift_id
      ${sql.raw(donorJoins)}
      WHERE cc.stripe_payout_id IN (${inList(payoutIds)})`)
          .then((r) => r.rows as unknown as PayoutGiftRow[])
      : Promise.resolve([]);

    const qbRowsP: Promise<QbAnchorRow[]> = qbIds.length
      ? db
          .execute(sql`
      SELECT
        s.id AS id,
        s.date_received::text AS date,
        s.amount::text AS amount,
        s.payer_name,
        s.raw_reference,
        s.line_description,
        s.qb_transaction_memo,
        ${sql.raw(qbStatusCase("s"))} AS status,
        ugm.group_id AS group_id,
        (SELECT count(*)::int FROM unit_group_members gm
          WHERE gm.group_id = ugm.group_id AND gm.evidence_source = 'quickbooks') AS group_member_count,
        (SELECT SUM(m.amount)::text FROM unit_group_members gm
          JOIN staged_payments m ON m.id = gm.source_id
          WHERE gm.group_id = ugm.group_id AND gm.evidence_source = 'quickbooks') AS group_total,
        COALESCE((
          SELECT json_agg(json_build_object(
              'stagedPaymentId', m.id,
              'role', 'group_member',
              'reference', m.raw_reference,
              'lineDescription', m.line_description,
              'memo', m.qb_transaction_memo,
              'amount', m.amount::text,
              'dateReceived', m.date_received::text,
              'status', ${sql.raw(qbStatusCase("m"))},
              'linkedChargeId', NULL
            ))
          FROM unit_group_members gm
          JOIN staged_payments m ON m.id = gm.source_id
          WHERE gm.group_id = ugm.group_id AND gm.evidence_source = 'quickbooks'
            AND m.id <> s.id
        ), '[]'::json) AS group_members,
        (SELECT array_agg(gm.source_id) FROM unit_group_members gm
          WHERE gm.group_id = ugm.group_id AND gm.evidence_source = 'quickbooks') AS member_ids
      FROM staged_payments s
      LEFT JOIN unit_group_members ugm
        ON ugm.evidence_source = 'quickbooks' AND ugm.source_id = s.id
      WHERE s.id IN (${inList(qbIds)})`)
          .then((r) => r.rows as unknown as QbAnchorRow[])
      : Promise.resolve([]);

    const qbGiftsP: Promise<QbGiftRow[]> = qbIds.length
      ? qbRowsP.then(async (qbRows) => {
          const allMemberIds = new Set<string>();
          for (const r of qbRows) {
            allMemberIds.add(r.id);
            for (const mid of r.member_ids ?? []) allMemberIds.add(mid);
          }
          if (allMemberIds.size === 0) return [];
          const result = await db.execute(sql`
      SELECT
        pa_j.payment_id AS payment_id,
        g.id AS gift_id,
        g.name AS gift_name,
        g.amount::text AS amount,
        g.date_received::text AS date_received,
        g.quickbooks_tie_status::text AS quickbooks_tie,
        ${sql.raw(donorFields)},
        ${sql.raw(donorboxBacked)} AS donorbox
      FROM payment_applications pa_j
      JOIN gifts_and_payments g ON g.id = pa_j.gift_id
      ${sql.raw(donorJoins)}
      WHERE pa_j.link_role = 'counted' AND pa_j.payment_id IN (${inList([...allMemberIds])})`);
          return result.rows as unknown as QbGiftRow[];
        })
      : Promise.resolve([]);

    const crmGiftsP: Promise<CrmGiftRow[]> = crmIds.length
      ? db
          .execute(sql`
      SELECT
        g.id AS gift_id,
        g.name AS gift_name,
        g.name AS title_gift_name,
        g.amount::text AS amount,
        g.date_received::text AS date_received,
        g.quickbooks_tie_status::text AS quickbooks_tie,
        ${sql.raw(donorFields)},
        ${sql.raw(donorboxBacked)} AS donorbox
      FROM gifts_and_payments g
      ${sql.raw(donorJoins)}
      WHERE g.id IN (${inList(crmIds)})`)
          .then((r) => r.rows as unknown as CrmGiftRow[])
      : Promise.resolve([]);

    const [payoutRows, payoutGifts, qbRows, qbGifts, crmGifts] = await Promise.all([
      payoutRowsP,
      payoutGiftsP,
      qbRowsP,
      qbGiftsP,
      crmGiftsP,
    ]);

    /* ── index hydration by anchor id ── */

    const payoutById = new Map(payoutRows.map((r) => [r.id, r]));
    const qbById = new Map(qbRows.map((r) => [r.id, r]));
    const crmById = new Map(crmGifts.map((r) => [r.gift_id, r]));

    // payout → gifts (dedupe by gift, merge charge ids)
    const payoutGiftsByPayout = new Map<string, Map<string, GiftOut>>();
    for (const row of payoutGifts) {
      let gifts = payoutGiftsByPayout.get(row.payout_id);
      if (!gifts) {
        gifts = new Map();
        payoutGiftsByPayout.set(row.payout_id, gifts);
      }
      let g = gifts.get(row.gift_id);
      if (!g) {
        g = giftOut(row, viewer);
        gifts.set(row.gift_id, g);
      }
      if (!g.linkedChargeIds.includes(row.charge_id)) g.linkedChargeIds.push(row.charge_id);
    }

    // qb member id → anchor id, then gifts per anchor (dedupe, merge member ids)
    const memberToAnchor = new Map<string, string>();
    for (const r of qbRows) {
      memberToAnchor.set(r.id, r.id);
      for (const mid of r.member_ids ?? []) memberToAnchor.set(mid, r.id);
    }
    const qbGiftsByAnchor = new Map<string, Map<string, GiftOut>>();
    for (const row of qbGifts) {
      const anchorId = memberToAnchor.get(row.payment_id);
      if (!anchorId) continue;
      let gifts = qbGiftsByAnchor.get(anchorId);
      if (!gifts) {
        gifts = new Map();
        qbGiftsByAnchor.set(anchorId, gifts);
      }
      let g = gifts.get(row.gift_id);
      if (!g) {
        g = giftOut(row, viewer);
        gifts.set(row.gift_id, g);
      }
      if (!g.linkedStagedPaymentIds.includes(row.payment_id)) {
        g.linkedStagedPaymentIds.push(row.payment_id);
      }
    }

    /* ── assemble in page order ── */

    const data = slim.map((r) => {
      const base = {
        id: `${r.kind}:${r.anchor_id}`,
        kind: r.kind,
        anchorId: r.anchor_id,
        lenses: lensesOf(r),
      };

      if (r.kind === "stripe_payout") {
        const h = payoutById.get(r.anchor_id);
        const gifts = [...(payoutGiftsByPayout.get(r.anchor_id)?.values() ?? [])];
        // Deposit QB record first, then fee/tie rows (deduped).
        const qbRecords: QbRecordJson[] = [];
        if (h?.dep_id) {
          qbRecords.push({
            stagedPaymentId: h.dep_id,
            role: "deposit",
            reference: h.dep_reference,
            lineDescription: h.dep_line_description,
            memo: h.dep_memo,
            amount: h.dep_amount,
            dateReceived: h.dep_date,
            status: h.dep_status ?? "pending",
            linkedChargeId: null,
          });
        }
        const seen = new Set<string>();
        for (const row of h?.linked_qb_rows ?? []) {
          const key = `${row.stagedPaymentId}:${row.role}:${row.linkedChargeId ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          qbRecords.push(row);
        }
        const resolved = h?.resolved_count ?? 0;
        const total = h?.total_count ?? 0;
        const detailParts = [`${resolved} of ${total} charges matched`];
        if (h?.settled) detailParts.push("deposit settled");
        else if (r.f_conflict) detailParts.push("deposit tie conflicts with an approved gift");
        else if (h?.sl_lifecycle === "proposed") detailParts.push("deposit tie proposed");
        else detailParts.push("no deposit tie yet");
        if (r.f_refund) detailParts.push("refund awaiting review");
        return {
          ...base,
          date: h?.date ?? r.anchor_date,
          title: h?.deposit_payer_name ?? null,
          grossTotal: h?.gross_total ?? null,
          feeTotal: h?.fee_total ?? null,
          netTotal: h?.net_total ?? null,
          bankAmount: h?.bank_amount ?? null,
          gapAmount: gapOf(h?.net_total ?? null, h?.bank_amount ?? null),
          resolvedCount: resolved,
          totalCount: total,
          chargeCount: h?.charge_count ?? null,
          status: statusOf(r, resolved),
          statusDetail: detailParts.join(" · "),
          gifts,
          charges: h?.charges ?? [],
          qbRecords,
          settlement: h?.sl_lifecycle
            ? {
                lifecycle: h.sl_lifecycle,
                depositStagedPaymentId: h.sl_deposit_id,
                conflictGiftId: h.sl_conflict_gift_id,
              }
            : null,
          group: null,
        };
      }

      if (r.kind === "qb_standalone") {
        const h = qbById.get(r.anchor_id);
        const gifts = [...(qbGiftsByAnchor.get(r.anchor_id)?.values() ?? [])];
        const qbRecords: QbRecordJson[] = h
          ? [
              {
                stagedPaymentId: h.id,
                role: "anchor",
                reference: h.raw_reference,
                lineDescription: h.line_description,
                memo: h.qb_transaction_memo,
                amount: h.amount,
                dateReceived: h.date,
                status: h.status,
                linkedChargeId: null,
              },
              ...h.group_members,
            ]
          : [];
        const total = qbRecords.filter((x) => x.status !== "excluded").length;
        const resolved = qbRecords.filter((x) => x.status === "match_confirmed").length;
        const isGroup = h?.group_id != null;
        const statusDetail = isGroup
          ? `${resolved} of ${total} group rows matched`
          : (QB_STATUS_DETAIL[h?.status ?? "pending"] ?? null);
        return {
          ...base,
          date: h?.date ?? r.anchor_date,
          title: h?.payer_name ?? h?.raw_reference ?? null,
          grossTotal: null,
          feeTotal: null,
          netTotal: isGroup ? (h?.group_total ?? null) : (h?.amount ?? null),
          bankAmount: h?.amount ?? null,
          gapAmount: null,
          resolvedCount: resolved,
          totalCount: total,
          chargeCount: null,
          status: statusOf(r, resolved),
          statusDetail,
          gifts,
          charges: [],
          qbRecords,
          settlement: null,
          group: isGroup
            ? {
                memberCount: h?.group_member_count ?? 0,
                totalAmount: h?.group_total ?? null,
              }
            : null,
        };
      }

      // crm_only
      const h = crmById.get(r.anchor_id);
      const maskedDonor = h
        ? maskName(
            h.donor_name,
            { anonymous: h.donor_anonymous, ownerUserId: h.donor_owner_user_id },
            viewer,
          )
        : null;
      return {
        ...base,
        date: h?.date_received ?? r.anchor_date,
        title: maskedDonor ?? h?.title_gift_name ?? null,
        grossTotal: null,
        feeTotal: null,
        netTotal: h?.amount ?? null,
        bankAmount: null,
        gapAmount: null,
        resolvedCount: null,
        totalCount: null,
        chargeCount: null,
        status: statusOf(r, null),
        statusDetail: "no accounting record yet",
        gifts: h ? [giftOut(h, viewer)] : [],
        charges: [],
        qbRecords: [],
        settlement: null,
        group: null,
      };
    });

    res.json({
      data,
      lensCounts: {
        all_open: lensCounts.all_open ?? 0,
        needs_donor_or_gift: lensCounts.needs_donor_or_gift ?? 0,
        needs_accounting: lensCounts.needs_accounting ?? 0,
        conflicts: lensCounts.conflicts ?? 0,
        refunds: lensCounts.refunds ?? 0,
        excluded: lensCounts.excluded ?? 0,
        completed: lensCounts.completed ?? 0,
      },
      pagination: { page, limit, total: lensCounts[lens] ?? 0 },
    });
  }),
);

export default router;
