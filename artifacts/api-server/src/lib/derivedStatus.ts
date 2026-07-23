import { sql, type SQL } from "drizzle-orm";

/**
 * SINGLE SOURCE OF TRUTH for the derived reconciliation status of staged
 * QuickBooks payments (`staged_payments`) and staged Stripe charges
 * (`stripe_staged_charges`).
 *
 * There is NO stored status column on either table — status is a pure
 * derivation over facts, so a row can never claim a state its facts don't
 * support and nothing can silently go stale. Precedence order:
 *
 *   excluded        ⇐ exclusion_reason IS NOT NULL. The row was classified as
 *                     non-donation noise (auto or manual) — out of the money
 *                     flow entirely.
 *   match_proposed  ⇐ auto_applied AND match_confirmed_at IS NULL AND a
 *                     counted payment_applications row anchored on this row
 *                     (QB and Stripe alike — the ledger is the SOLE gift-link
 *                     record). The system applied a high-confidence match that
 *                     a human has not yet reviewed.
 *   match_confirmed ⇐ the money is booked to a CRM gift, evidenced by ANY of:
 *                       - a counted payment_applications ledger row anchored
 *                         on this row (the SOLE gift-link record for QB staged
 *                         payments AND Stripe charges; covers direct links,
 *                         mints, group members, and splits; ALL legacy gift-
 *                         pointer columns — staged_payments AND
 *                         stripe_staged_charges matched/created — are
 *                         @deprecated, never read, never written)
 *                       - the settled-payout pairing fact naming this row as
 *                         the QB deposit lump (QB only — the deposit is
 *                         settled against a Stripe payout, its money booked
 *                         per-charge; settled_stripe_payout_id, 0168)
 *                       - a BOOKED charge-grain tie claiming this row (QB
 *                         only — a confirmed source_links charge_qb_tie row
 *                         names it from a Stripe charge AND that charge itself
 *                         carries a counted ledger row; the gift booking lives
 *                         on the CHARGE, moved there by chargeTieSupersede.ts)
 *   excluded (derived) ⇐ no stronger arm matched AND the row is CLAIMED as
 *                       confirmed Stripe settlement evidence (a confirmed
 *                       charge-grain tie names it, booked or not, or a
 *                       confirmed fee-row claim marks it a charge's sibling
 *                       Stripe-fee line). Its money is tracked at the STRIPE
 *                       charge grain, so it is settled OUT of the donation
 *                       review queue — without a stored exclusion_reason.
 *   pending         ⇐ none of the above — open work awaiting review.
 *
 * `match_proposed` is checked BEFORE `match_confirmed` because a proposed row
 * also carries a gift link; human confirmation (match_confirmed_at) or
 * autoApplied=false is what promotes it.
 *
 * TIE ≠ match_confirmed. A charge-grain tie (a source_links row with
 * link_type='charge_qb_tie') is a claim that a charge and a QB row are the
 * same money. The claim alone NEVER produces match_confirmed: only the booking on the tied
 * charge (its counted ledger row) is that evidence. A confirmed-but-unbooked
 * tie DOES derive `excluded` (see the derived-excluded arm above): the row is
 * settled evidence, not review work, and it promotes to match_confirmed when
 * the tied charge books. The raw-linkage predicate
 * (`qbChargeTieLinkExistsText` / `stagedChargeTieLinkExists`) additionally
 * serves claim semantics — pick-list blockers and eligibility filters.
 *
 * TWO REPRESENTATIONS, ONE SOURCE:
 *
 *   1. Alias-parameterized TEXT builders (`qb*Text` / `charge*Text`) — the
 *      canonical definitions. They take the caller's table alias and return
 *      SQL text, so aliased/raw-SQL contexts (workbench clusters, bundle
 *      anchors, reconciliation graph, aliased drizzle joins via `sql.raw`)
 *      share the exact same derivation instead of hand-rolling a twin.
 *   2. The drizzle `SQL` fragments below (`stagedStatusSql`, `stagedStatusWhere`,
 *      `chargeStatusSql`, …) are DERIVED from those builders with the base
 *      table name as the alias. Use them in queries that reference the
 *      UNALIASED base tables.
 *
 * SAFETY: every caller-supplied alias passes `quotedSqlAlias` — it must be a
 * plain lowercase SQL identifier (anything else throws, so no untrusted text
 * can ride through the raw-SQL seam) and is rendered double-quoted, exactly
 * as drizzle renders identifiers. Internal subquery aliases carry the
 * reserved `_ds` suffix (`pa_ds`, `sl_ds`, `cc_ds`, `pa_ct_ds`) and are
 * rejected as caller aliases so they can never collide.
 *
 * NOTE (drizzle footgun): columns of an alias() table render UNQUALIFIED
 * inside sql`` templates. If your query aliases staged_payments /
 * stripe_staged_charges, do NOT interpolate the base-table fragments — use
 * `sql.raw(qbStatusCaseText("<your_alias>"))` (etc.) instead.
 */

export const DERIVED_STATUSES = [
  "pending",
  "match_proposed",
  "match_confirmed",
  "excluded",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

/* ── Write-path status vocabulary (deliberate decision) ─────────────────────
 *
 * Write-path lifecycle guards (the reconciliation approve/link/mint/revert/
 * exclude routes) branch on THIS DerivedStatus vocabulary — never on the
 * read-path card-state mapping (`qbCardStateOfStatus` in
 * routes/reconciliation/workbenchRowState.ts). Card states are a PRESENTATION
 * projection derived FROM DerivedStatus; routing guards through them would
 * invert that dependency and blur lifecycle facts the write path must
 * distinguish (e.g. "matched_complete" covers both a counted booking and a
 * settlement-only confirmation, which mint vs link paths treat differently).
 *
 * Drift protection is TYPE-LEVEL instead of mapping-level: every guard
 * comparison goes through the typed constants/predicates below on
 * DerivedStatus values, so renaming, removing, or adding a status is a
 * compile error at every guard — the two vocabularies cannot silently drift.
 */

/** Still open for donor/gift review work: pending or an unreviewed proposal.
 *  The gate's APPROVABLE_STAGED_STATUSES aliases this set — one authority. */
export const OPEN_STATUSES = [
  "pending",
  "match_proposed",
] as const satisfies readonly DerivedStatus[];

/** Carrying a gift link of its own (proposed or confirmed) — revertible. */
export const LINKED_STATUSES = [
  "match_proposed",
  "match_confirmed",
] as const satisfies readonly DerivedStatus[];

/** Open = pending OR match_proposed (still needs donor/gift work). */
export function isOpenStatus(
  status: DerivedStatus,
): status is (typeof OPEN_STATUSES)[number] {
  return (OPEN_STATUSES as readonly DerivedStatus[]).includes(status);
}

/** Linked = match_proposed OR match_confirmed (a gift link exists). */
export function isLinkedStatus(
  status: DerivedStatus,
): status is (typeof LINKED_STATUSES)[number] {
  return (LINKED_STATUSES as readonly DerivedStatus[]).includes(status);
}

/** Booked/settled: confirmed evidence ties this row's money to a gift. */
export function isBookedStatus(
  status: DerivedStatus,
): status is "match_confirmed" {
  return status === "match_confirmed";
}

/** Untouched — free to claim, mint against, or resolve. */
export function isPendingStatus(status: DerivedStatus): status is "pending" {
  return status === "pending";
}

/** Excluded from the money flow (stored reason or derived settlement claim). */
export function isExcludedStatus(status: DerivedStatus): status is "excluded" {
  return status === "excluded";
}

/* ── Alias validation & quoting ────────────────────────────────────────── */

const SQL_ALIAS_RE = /^[a-z_][a-z0-9_]*$/;

/** Subquery aliases reserved by the builders themselves. */
const RESERVED_INTERNAL_ALIASES = new Set([
  "pa_ds",
  "sl_ds",
  "cc_ds",
  "pa_ct_ds",
  "sp_ds",
]);

/**
 * Validate and double-quote a caller-supplied table alias. Throws unless the
 * alias is a plain lowercase SQL identifier (quoted-lowercase ≡ unquoted-
 * folded, so callers may still write the alias unquoted in their own SQL) and
 * is not one of the builders' reserved internal aliases. This is the ONLY
 * path caller text takes into the generated SQL.
 */
export function quotedSqlAlias(alias: string): string {
  if (!SQL_ALIAS_RE.test(alias)) {
    throw new Error(
      `derivedStatus: table alias must be a plain lowercase SQL identifier, got ${JSON.stringify(alias)}`,
    );
  }
  if (RESERVED_INTERNAL_ALIASES.has(alias)) {
    throw new Error(
      `derivedStatus: table alias ${JSON.stringify(alias)} is reserved for the builders' internal subqueries`,
    );
  }
  return `"${alias}"`;
}

/* ── Alias-parameterized text builders — THE canonical derivation ──────── */

/** EXISTS: a counted cash-application ledger row anchored on QB row `alias`. */
export function qbCountedExistsText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `EXISTS (SELECT 1 FROM "payment_applications" "pa_ds" WHERE "pa_ds"."payment_id" = ${a}."id" AND "pa_ds"."link_role" = 'counted')`;
}

/** QB row `alias` is the settled QBO lump of a Stripe payout (the plain
 *  pairing fact that replaced the settlement_links workflow, 0168). */
export function qbSettledExistsText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."settled_stripe_payout_id" IS NOT NULL)`;
}

/** EXISTS: a BOOKED charge-grain tie claims QB row `alias` — some Stripe
 *  charge (of an individually-booked payout) names it as its QB record AND
 *  that charge carries a counted ledger row (the gift booking lives on the
 *  CHARGE, moved there by chargeTieSupersede.ts). Mere linkage is NOT
 *  evidence: a refunded or not-yet-booked tied charge leaves the QB row's own
 *  status untouched (the refund sweep and the workbench still own that work). */
export function qbChargeTieBookedExistsText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `EXISTS (SELECT 1 FROM "source_links" "srcl_ds" WHERE "srcl_ds"."link_type" = 'charge_qb_tie' AND "srcl_ds"."lifecycle" = 'confirmed' AND "srcl_ds"."qb_staged_payment_id" = ${a}."id" AND EXISTS (SELECT 1 FROM "payment_applications" "pa_ct_ds" WHERE "pa_ct_ds"."stripe_charge_id" = "srcl_ds"."stripe_charge_id" AND "pa_ct_ds"."evidence_source" = 'stripe' AND "pa_ct_ds"."link_role" = 'counted'))`;
}

/** EXISTS: RAW charge-grain tie linkage — some Stripe charge names QB row
 *  `alias`, booked or not. This is the CLAIM fact (pick-list blockers,
 *  eligibility filters): re-tying the row elsewhere would conflict even
 *  before the charge's money is booked. NEVER status evidence — that is
 *  `qbChargeTieBookedExistsText` (which additionally requires the booking). */
export function qbChargeTieLinkExistsText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `EXISTS (SELECT 1 FROM "source_links" "srcl_ds" WHERE "srcl_ds"."link_type" = 'charge_qb_tie' AND "srcl_ds"."lifecycle" = 'confirmed' AND "srcl_ds"."qb_staged_payment_id" = ${a}."id")`;
}

/** A system-proposed (worker/rule) application awaiting human review. The
 *  counted ledger row is the sole gift-link source; group and split
 *  resolutions always carry match_confirmed_at, so only worker auto-matches
 *  and rule auto-mints can sit here. */
export function qbProposedText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."auto_applied" = true AND ${a}."match_confirmed_at" IS NULL AND ${qbCountedExistsText(alias)})`;
}

/** ANY confirmed-booking evidence for QB row `alias` (counted / settled /
 *  tied-AND-booked). A raw tie without its booking is deliberately absent. */
export function qbConfirmedEvidenceText(alias: string): string {
  return `(${qbCountedExistsText(alias)} OR ${qbSettledExistsText(alias)} OR ${qbChargeTieBookedExistsText(alias)})`;
}

/** EXISTS: QB row `alias` is CLAIMED as confirmed Stripe settlement evidence —
 *  a confirmed charge-grain tie names it (booked or not), or a confirmed
 *  fee-row claim names it as a charge's sibling "Stripe fee" line. Such a row
 *  is the QB-side record of money whose donor/gift work lives on the STRIPE
 *  charge, so it is settled OUT of the donation review queue (derives
 *  `excluded` below) even without its own exclusion_reason. The confirmed
 *  settlement-link deposit case is deliberately absent here — it already
 *  derives match_confirmed via {@link qbConfirmedEvidenceText}. */
export function qbSettlementClaimedText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${qbChargeTieLinkExistsText(alias)} OR EXISTS (SELECT 1 FROM "source_links" "srcl_ds" WHERE "srcl_ds"."link_type" = 'charge_fee_row' AND "srcl_ds"."lifecycle" = 'confirmed' AND "srcl_ds"."qb_staged_payment_id" = ${a}."id"))`;
}

/** EXISTS: synthetic split children name QB row `alias` as their parent —
 *  the row was "split into reconciliation units" (workbench-business-rules
 *  §7.2). The parent's money story is then told ENTIRELY by its children
 *  (which tie, settle, and book like real rows), so the parent itself is
 *  settled OUT of the review queue and out of every matcher/picker.
 *  `split_parent_id IS NOT NULL` on the child side is the single authority —
 *  this predicate is that same fact read from the parent side. */
export function qbHasSplitChildrenText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `EXISTS (SELECT 1 FROM "staged_payments" "sp_ds" WHERE "sp_ds"."split_parent_id" = ${a}."id")`;
}

/** The row's review work is RESOLVED ELSEWHERE: claimed as confirmed Stripe
 *  settlement evidence, OR split into synthetic child units. Either way the
 *  row derives `excluded` (settled, not review work) without a stored
 *  exclusion_reason, and un-claiming/un-splitting restores it. */
export function qbResolvedElsewhereText(alias: string): string {
  return `(${qbSettlementClaimedText(alias)} OR ${qbHasSplitChildrenText(alias)})`;
}

/** A WHOLE-deposit header record (qb_entity_type='deposit_header') — staged
 *  only when a bank Deposit yields zero direct-line rows because every line
 *  re-records an ingested Payment/SalesReceipt. Its money is already counted
 *  on those Payment rows, so a header is NEVER donation-review work: it
 *  derives `excluded` by entity type alone (no stored exclusion_reason).
 *  Precedence: sits AFTER match_confirmed so a header named by a confirmed
 *  settlement link still reads match_confirmed (settled evidence), exactly
 *  like a deposit-line lump. */
export function qbIsDepositHeaderText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."qb_entity_type" = 'deposit_header')`;
}

/** The full derived-status CASE for QB row `alias` (parenthesized, no cast).
 *  The resolved-elsewhere arm sits AFTER match_confirmed on purpose: a tied
 *  row whose charge is already booked stays match_confirmed (the booking is
 *  the stronger fact); an unbooked-but-confirmed tie, a claimed fee sibling,
 *  or a split parent derives `excluded` — settled evidence, not donation
 *  review work. (The split service refuses to split a row that carries any
 *  booking evidence, so a split parent never reaches the stronger arms.) */
export function qbStatusCaseText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(CASE
  WHEN ${a}."exclusion_reason" IS NOT NULL THEN 'excluded'
  WHEN ${qbProposedText(alias)} THEN 'match_proposed'
  WHEN ${qbConfirmedEvidenceText(alias)} THEN 'match_confirmed'
  WHEN ${qbResolvedElsewhereText(alias)} THEN 'excluded'
  WHEN ${qbIsDepositHeaderText(alias)} THEN 'excluded'
  ELSE 'pending'
END)`;
}

/** Open = pending OR match_proposed (still needs donor/gift work). A
 *  deposit_header is never open — it is settlement evidence, not review work. */
export function qbOpenText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."exclusion_reason" IS NULL AND NOT ${qbIsDepositHeaderText(alias)} AND (
  (NOT ${qbConfirmedEvidenceText(alias)} AND NOT ${qbResolvedElsewhereText(alias)})
  OR ${qbProposedText(alias)}
))`;
}

/** EXISTS: a counted Stripe cash-application ledger row anchored on charge `alias`. */
export function chargeCountedExistsText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `EXISTS (SELECT 1 FROM "payment_applications" "pa_ds" WHERE "pa_ds"."stripe_charge_id" = ${a}."id" AND "pa_ds"."evidence_source" = 'stripe' AND "pa_ds"."link_role" = 'counted')`;
}

export function chargeProposedText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."auto_applied" = true AND ${a}."match_confirmed_at" IS NULL AND ${chargeCountedExistsText(alias)})`;
}

/** The full derived-status CASE for Stripe charge `alias` (parenthesized, no cast). */
export function chargeStatusCaseText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(CASE
  WHEN ${a}."exclusion_reason" IS NOT NULL THEN 'excluded'
  WHEN ${chargeProposedText(alias)} THEN 'match_proposed'
  WHEN ${chargeCountedExistsText(alias)} THEN 'match_confirmed'
  ELSE 'pending'
END)`;
}

/** Open = pending OR match_proposed (still needs donor/gift work). */
export function chargeOpenText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."exclusion_reason" IS NULL AND (
  NOT ${chargeCountedExistsText(alias)}
  OR ${chargeProposedText(alias)}
))`;
}

/** Confirmed = counted AND past the proposed gate (human-ratified). */
export function chargeConfirmedText(alias: string): string {
  const a = quotedSqlAlias(alias);
  return `(${a}."exclusion_reason" IS NULL AND ${chargeCountedExistsText(alias)} AND NOT ${chargeProposedText(alias)})`;
}

/* ── staged_payments (QuickBooks) — base-table drizzle fragments ────────── */

const QB = "staged_payments";
const QBA = quotedSqlAlias(QB);

/** This row is the settled QBO lump of a Stripe payout (0168 pairing fact). */
export const stagedConfirmedSettlementLinkExists: SQL<boolean> = sql.raw(
  qbSettledExistsText(QB),
) as SQL<boolean>;

/** EXISTS: a counted cash-application ledger row is anchored on this row. */
export const stagedCountedApplicationExists: SQL<boolean> = sql.raw(
  qbCountedExistsText(QB),
) as SQL<boolean>;

/** EXISTS: a BOOKED charge-grain tie claims this row (see the text builder). */
export const stagedChargeTieExists: SQL<boolean> = sql.raw(
  qbChargeTieBookedExistsText(QB),
) as SQL<boolean>;

/** EXISTS: RAW charge-grain tie linkage (CLAIM fact — see the text builder). */
export const stagedChargeTieLinkExists: SQL<boolean> = sql.raw(
  qbChargeTieLinkExistsText(QB),
) as SQL<boolean>;

/** SELECTable CASE expression emitting the derived status for a staged payment. */
export const stagedStatusSql: SQL<DerivedStatus> = sql
  .raw(qbStatusCaseText(QB))
  .mapWith(String) as SQL<DerivedStatus>;

/** Per-status WHERE predicates (mutually exclusive, exhaustive). */
export const stagedStatusWhere: Record<DerivedStatus, SQL<boolean>> = {
  excluded: sql.raw(
    `(${QBA}."exclusion_reason" IS NOT NULL OR (NOT ${qbProposedText(QB)} AND NOT ${qbConfirmedEvidenceText(QB)} AND (${qbResolvedElsewhereText(QB)} OR ${qbIsDepositHeaderText(QB)})))`,
  ) as SQL<boolean>,
  match_proposed: sql.raw(
    `(${QBA}."exclusion_reason" IS NULL AND ${qbProposedText(QB)})`,
  ) as SQL<boolean>,
  match_confirmed: sql.raw(
    `(${QBA}."exclusion_reason" IS NULL AND NOT ${qbProposedText(QB)} AND ${qbConfirmedEvidenceText(QB)})`,
  ) as SQL<boolean>,
  pending: sql.raw(
    `(${QBA}."exclusion_reason" IS NULL AND NOT ${qbConfirmedEvidenceText(QB)} AND NOT ${qbResolvedElsewhereText(QB)} AND NOT ${qbIsDepositHeaderText(QB)})`,
  ) as SQL<boolean>,
};

/** EXISTS: this row has synthetic split children (it is a split PARENT).
 *  Matchers and pickers use this to keep parents out of candidate pools —
 *  the children are the tieable units. */
export const stagedHasSplitChildren: SQL<boolean> = sql.raw(
  qbHasSplitChildrenText(QB),
) as SQL<boolean>;

/** OR-combination of per-status predicates for queue/filter params. */
export function stagedStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((s) => stagedStatusWhere[s]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── stripe_staged_charges — base-table drizzle fragments ──────────────── */

const CH = "stripe_staged_charges";
const CHA = quotedSqlAlias(CH);

/** EXISTS: a counted Stripe cash-application ledger row anchored on this charge. */
export const chargeCountedApplicationExists: SQL<boolean> = sql.raw(
  chargeCountedExistsText(CH),
) as SQL<boolean>;

/** SELECTable CASE expression emitting the derived status for a Stripe charge. */
export const chargeStatusSql: SQL<DerivedStatus> = sql
  .raw(chargeStatusCaseText(CH))
  .mapWith(String) as SQL<DerivedStatus>;

/** Per-status WHERE predicates (mutually exclusive, exhaustive). */
export const chargeStatusWhere: Record<DerivedStatus, SQL<boolean>> = {
  excluded: sql.raw(`${CHA}."exclusion_reason" IS NOT NULL`) as SQL<boolean>,
  match_proposed: sql.raw(
    `(${CHA}."exclusion_reason" IS NULL AND ${chargeProposedText(CH)})`,
  ) as SQL<boolean>,
  match_confirmed: sql.raw(
    `(${CHA}."exclusion_reason" IS NULL AND NOT ${chargeProposedText(CH)} AND ${chargeCountedExistsText(CH)})`,
  ) as SQL<boolean>,
  pending: sql.raw(
    `(${CHA}."exclusion_reason" IS NULL AND NOT ${chargeCountedExistsText(CH)})`,
  ) as SQL<boolean>,
};

export function chargeStatusIn(statuses: readonly DerivedStatus[]): SQL<boolean> {
  const parts = statuses.map((s) => chargeStatusWhere[s]);
  if (parts.length === 0) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/* ── TS-side derivation (for rows already in memory) ───────────────────── */

export interface StagedStatusFacts {
  exclusionReason: string | null;
  autoApplied: boolean;
  matchConfirmedAt: Date | string | null;
  /**
   * EXISTS: a counted QB cash-application ledger row anchored on this payment.
   * The SOLE gift-link fact (read cutover) — the legacy matched/created/group
   * columns are no longer consulted. Callers must pass what they know about
   * the ledger at echo time (link/mint/split echoes → true; revert → false).
   */
  hasCountedApplication: boolean;
  /** EXISTS arm — pass when known; default false (QB-rare deposit shape). */
  hasConfirmedSettlementLink?: boolean;
  /** EXISTS arm — a BOOKED charge-grain tie claims this row (a confirmed
   * source_links charge_qb_tie row names it from a Stripe charge AND that charge carries a
   * counted ledger row). Mere linkage is NOT evidence — pass true only when
   * the tied charge's booking is known-counted; default false. */
  hasConfirmedChargeTie?: boolean;
  /** EXISTS arm — the row is CLAIMED as confirmed Stripe settlement evidence:
   * a confirmed charge-grain tie names it (booked or not) OR a confirmed
   * fee-row claim names it as a charge's sibling fee line. Derives `excluded`
   * (settled out of the donation review queue) when no stronger booking
   * evidence exists — mirrors qbSettlementClaimedText; default false. */
  hasSettlementClaim?: boolean;
  /** EXISTS arm — synthetic split children name this row as parent (it was
   * split into reconciliation units). Derives `excluded` like a settlement
   * claim: the children tell the money story — mirrors
   * qbHasSplitChildrenText; default false. */
  hasSplitChildren?: boolean;
  /** The row's qb_entity_type when known. A 'deposit_header' row (whole-deposit
   * record; its money is counted on the underlying Payment rows) derives
   * `excluded` by type alone — mirrors qbIsDepositHeaderText. Callers echoing a
   * staged row they hold MUST pass this so a header never echoes `pending`. */
  qbEntityType?: string | null;
}

export function deriveStagedPaymentStatus(f: StagedStatusFacts): DerivedStatus {
  if (f.exclusionReason != null) return "excluded";
  if (f.autoApplied && f.matchConfirmedAt == null && f.hasCountedApplication) {
    return "match_proposed";
  }
  if (
    f.hasCountedApplication ||
    f.hasConfirmedSettlementLink === true ||
    f.hasConfirmedChargeTie === true
  ) {
    return "match_confirmed";
  }
  if (f.hasSettlementClaim === true || f.hasSplitChildren === true) {
    return "excluded";
  }
  if (f.qbEntityType === "deposit_header") return "excluded";
  return "pending";
}

export interface ChargeStatusFacts {
  exclusionReason: string | null;
  autoApplied: boolean;
  matchConfirmedAt: Date | string | null;
  /**
   * EXISTS: a counted Stripe cash-application ledger row anchored on this
   * charge. The SOLE gift-link fact (read cutover) — the legacy
   * matched_gift_id / created_gift_id columns were dropped (0126). Callers
   * pass what they know about the ledger at echo time (link/mint echoes →
   * true; revert → false).
   */
  hasCountedApplication: boolean;
}

export function deriveStripeChargeStatus(f: ChargeStatusFacts): DerivedStatus {
  if (f.exclusionReason != null) return "excluded";
  if (f.autoApplied && f.matchConfirmedAt == null && f.hasCountedApplication) {
    return "match_proposed";
  }
  if (f.hasCountedApplication) return "match_confirmed";
  return "pending";
}

/**
 * Donorbox keeps its STORED status column (its lifecycle is genuinely
 * write-driven), but the API speaks the same derived vocabulary everywhere:
 * both legacy resolutions map to match_confirmed.
 */
export function donorboxEmittedStatus(
  stored: "pending" | "approved" | "rejected" | "excluded" | "reconciled",
): DerivedStatus {
  switch (stored) {
    case "approved":
    case "reconciled":
      return "match_confirmed";
    case "excluded":
    case "rejected":
      return "excluded";
    default:
      return "pending";
  }
}
