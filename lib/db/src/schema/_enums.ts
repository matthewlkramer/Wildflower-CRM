import { pgEnum } from "drizzle-orm/pg-core";

export const regionTypeEnum = pgEnum("region_type", [
  "state",
  "metro_area",
  "city",
  "neighborhood",
  "region_within_state",
  "multi_state_region",
  "country",
  "continent",
]);

export const entityRoleTypeEnum = pgEnum("entity_role_type", [
  "organization",
  "payment_intermediary",
  "household",
]);

// Tells us whether a contact endpoint actually works (e.g. an email that
// bounces is "invalid"). Independent of whether it is the preferred one
// of its type (see is_preferred boolean on emails / phone_numbers).
export const contactValidityEnum = pgEnum("contact_validity", [
  "valid",
  "invalid",
  "unknown",
]);

export const emailTypeEnum = pgEnum("email_type", [
  "work",
  "personal",
  "other",
]);

export const phoneTypeEnum = pgEnum("phone_type", [
  "work",
  "mobile",
  "home",
  "other",
]);

export const peopleRoleCurrentEnum = pgEnum("people_role_current", [
  "current",
  "past",
]);

// Lifecycle status of an opportunity/pledge row. FULLY CALCULATED — never
// set directly by users. Derived from stage + payments + loss_type:
//   loss_type set                         → status = loss_type (dormant|lost)
//   else fully paid (paid≥awarded) or stage=cash_in → cash_in
//   else stage = written_commitment                                 → pledge
//   else                                                             → open
//   open    — actively in the funnel, not yet committed
//   pledge  — funder has committed (stage = written, or conditional/
//             grant-letter sticky flag)
//   cash_in — fully paid (stage=cash_in or sum of payments >= awarded)
//   dormant — paused (mirrors loss_type='dormant')
//   lost    — declined/withdrawn (mirrors loss_type='lost')
// The dormant/lost override now lives in the separate `loss_type` column;
// status simply reports it. See opportunityLossTypeEnum below.
export const opportunityStatusEnum = pgEnum("opportunity_status", [
  "open",
  "pledge",
  "cash_in",
  "dormant",
  "lost",
]);

// User-set override that pulls an opportunity/pledge out of the calculated
// funnel. Nullable on the table: null while the row is open/pledge/cash_in;
// set to 'dormant' (paused) or 'lost' (declined/withdrawn) when the user
// marks it so. This is the ONLY user-settable part of the old `status`
// overload — `status` itself is now fully calculated from stage + payments
// + this value.
export const opportunityLossTypeEnum = pgEnum("opportunity_loss_type", [
  "dormant",
  "lost",
]);

// Lifecycle of a single pledge_allocation row. `working` is a draft an
// internal user is iterating on; `committed` / `committed_with_conditions`
// are firm commitments from the funder; `superseded_by_pledge` means the
// row was replaced by a later allocation (re-scoped or split differently);
// `superseded_by_gift` means an actual gift_allocation has taken its place
// (the money landed and the pledge row is now historical); `abandoned`
// means the allocation was dropped without being paid (the opp may still
// be open at a different scope, or fully lost). The legacy plain
// `superseded` value is retained in the DB enum for safety but unused —
// new writes should pick one of the two more specific variants.
export const pledgeAllocationStatusEnum = pgEnum("pledge_allocation_status", [
  "working",
  "committed",
  "superseded",
  "committed_with_conditions",
  "superseded_by_pledge",
  "superseded_by_gift",
  "abandoned",
]);

export const paymentIntermediaryTypeEnum = pgEnum("payment_intermediary_type", [
  "daf",
  "giving_platform",
  "private_wealth_manager",
]);

// ---- Unified entity type (replaces fundingEntitySubtype + organizationType) ----
export const entityTypeEnum = pgEnum("entity_type", [
  "family_foundation",
  "institutional_foundation",
  "corporate_foundation",
  "community_foundation",
  "bank_foundation",
  "family_office_trust",
  "intermediary",
  "government",
  "nonprofit",
  "corporation",
  "capital_provider",
  "philanthropic_advisor",
  "cdfi",
  "education_forprofit",
  "competition",
  "public_private",
  "daf_platform",
  "platform",
  "advocacy_membership_lobbyist",
  "authorizer",
  "education_vendor",
  "elected_official",
  "higher_ed",
  "investor",
  "law_firm",
  "media",
  "real_estate",
  "school",
  "school_district",
  "school_network",
  "small_business_consulting",
  "tribal",
]);

// ---- Funder enums (kept for migration compatibility — removed after Phase 2 push) ----
export const fundingEntitySubtypeEnum = pgEnum("funding_entity_subtype", [
  "family_foundation",
  "institutional_foundation",
  "corporate_foundation",
  "community_foundation",
  "bank_foundation",
  "family_office_trust",
  "intermediary",
  "government",
  "nonprofit",
  "corporation",
  "capital_provider",
  "philanthropic_advisor",
  "cdfi",
  "education_forprofit",
  "competition",
  "public_private",
  "daf_platform",
  "platform",
]);

export const numberOfEmployeesEnum = pgEnum("number_of_employees", [
  "e_1",
  "e_2_10",
  "e_11_50",
  "e_51_250",
  "e_251_1000",
  "e_1001_10000",
  "e_10000_plus",
]);

export const capacityRatingEnum = pgEnum("capacity_rating", [
  "tier_1k_10k",
  "tier_10k_50k",
  "tier_50k_250k",
  "tier_250k_1m",
  "tier_1m_plus",
]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "connected",
  "have_a_connector",
  "no_connection",
]);

export const priorityEnum = pgEnum("priority", [
  "top",
  "high",
  "medium",
  "low",
]);

export const enthusiasmEnum = pgEnum("enthusiasm", [
  "7-advocate",
  "6-supportive",
  "5-warm",
  "4-neutral",
  "3-cool",
  "2-unsupportive",
  "1-hostile",
]);

export const strategicAlignmentEnum = pgEnum("strategic_alignment", [
  "high",
  "medium",
  "low",
]);

export const activeStatusEnum = pgEnum("active_status", [
  "active",
  "defunct",
  "spenddown",
]);

// ---- Opportunity / pledge enums ----
export const opportunityTypeEnum = pgEnum("opportunity_type", [
  "solicitation",
  "renewal",
  "open_application",
]);

// Pure cultivation funnel. Stage is now SEPARATE from outcome: it tracks how
// far the conversation has progressed, and reads `complete` (terminal) once the
// opp is WON (written pledge or paid) — auto-driven server-side, never for
// lost/dormant rows. Stage values map to a default win-probability in the
// API layer. The three legacy commitment/outcome values
// (conditional_commitment, written_commitment, cash_in) are RETAINED for
// historical / un-migrated rows but are no longer written by the app — the
// commitment signal now lives on the separate `written_pledge` flag and the
// calculated `status`.
export const opportunityStageEnum = pgEnum("opportunity_stage", [
  "cold_lead",
  "warm_lead",
  "in_conversation",
  "convince",
  "conditional_commitment",
  "probable_renewal",
  "verbal_confirmation",
  "written_commitment",
  "cash_in",
  "complete",
]);

// Direct vs indirect share on a reimbursable-grant allocation line. Nullable
// (untagged is the default). DIRECT-tagged allocations are EXCLUDED from goal
// analytics (received, committed, open ask, weighted); untagged (null) and
// indirect both still count. Never affects opportunity-status or pledge
// paid-amount derivation (those keep summing all allocations). Manual entry only.
//
// Renamed from `reimbursable_share` → `reimbursement_type` (Task #449). The
// values are unchanged; this is a Publish-time pg-type + column RENAME (confirm
// in the Publish UI rather than diffing as drop+add; never push-force).
export const reimbursementTypeEnum = pgEnum("reimbursement_type", [
  "direct",
  "indirect",
]);

// Three-axis restriction taxonomy (Task #449) — ONE shared pg enum reused by the
// regional / fund-use / time restriction columns on BOTH gift_allocations and
// pledge_allocations. `donor_restricted` = the funder formally restricts this
// axis; `wf_restricted` = Wildflower board-designated (internal) restriction;
// `unrestricted` = no restriction. Replaces the coarse "formally restricted"
// booleans and the old restriction_type enum. Default `unrestricted`.
export const restrictionAxisEnum = pgEnum("restriction_axis", [
  "donor_restricted",
  "wf_restricted",
  "unrestricted",
]);

export const opportunityConditionalEnum = pgEnum("opportunity_conditional", [
  "unconditional",
  "conditional_unspecified",
  "reimbursable",
  "conditional_on_funder_determination",
  "conditional_on_target",
]);

// Tri-state "conditions met" on opportunities/pledges. Replaces the old
// boolean flag so grants that are only partially satisfied can be tracked.
// Default 'no' so legacy false/unset rows are non-destructively classified as
// 'no'; legacy true rows migrate to 'yes' (see migration 0059).
export const opportunityConditionsMetEnum = pgEnum("opportunity_conditions_met", [
  "no",
  "partial",
  "yes",
]);

// Fundraising category — splits loan-fund capital out of revenue so the two
// tracks can be reported in parallel (dashboard, projections, goals). Loan
// capital = principal investments (loan_fund_investment gifts + loan-capital
// opportunities/pledges); everything else is revenue. Default 'revenue' so
// existing data is non-destructively classified as revenue.
export const fundraisingCategoryEnum = pgEnum("fundraising_category", [
  "revenue",
  "loan_capital",
]);

// Authoritative loan-vs-grant classification — the SINGLE flag that designates
// whether a gift / opportunity / goal is loan-fund principal ("loan") or
// ordinary fundraising money ("grant"). Supersedes the two scattered legacy
// signals it is backfilled from and dual-written alongside during the
// transition:
//   - opportunities_and_pledges.fundraising_category (revenue→grant, loan_capital→loan)
//   - gifts_and_payments.type (loan_fund_investment→loan, everything else→grant)
// NOTE: 'grant' means ALL non-loan money — individual donations, foundation
// grants, earned revenue, etc. — NOT literally only grants. Default 'grant' so
// pre-existing rows are non-destructively classified. The 1:1 mappers live in
// @workspace/api-zod (loan-or-grant.ts).
export const loanOrGrantEnum = pgEnum("loan_or_grant", ["loan", "grant"]);

// ---- Gift / payment enums ----
export const giftTypeEnum = pgEnum("gift_type", [
  "standard_gift",
  "pledge_payment",
  "directed_gift",
  "loan_fund_investment",
  "matching_gift",
]);

export const giftPaymentMethodEnum = pgEnum("gift_payment_method", [
  "ach",
  "check",
  "wire",
  "stock",
  "donor_box",
  "daf_ach",
  "daf_check",
  "daf_bill_com",
]);

// What a contribution is intended to fund. When the value is "project",
// the fundable_project_id column on the same row links to the specific
// project (see fundable_projects table).
export const intendedUsageEnum = pgEnum("intended_usage", [
  "gen_ops",
  "growth",
  "school_startup",
  "teacher_training",
  "project",
]);

// ---- Revenue-accounting capture (CFO "Revenue Extractor") ----
// NOTE: the old coarse `restriction_type` enum (unrestricted/purpose/time/both/
// unclear/na) was retired once its last columns were dropped from the allocation
// tables (superseded by the three-axis `restriction_axis` taxonomy). The pg type
// itself is dropped in migration 0096. Do NOT re-add it.

// Deferred-revenue capture (CRM captures the answer; it does NOT compute AR).
export const deferredRevenueEnum = pgEnum("deferred_revenue", [
  "yes",
  "no",
  "na",
]);

// ──────────────────────────────────────────────────────────────────
// QuickBooks cash-application ledger (payment_applications)
// ──────────────────────────────────────────────────────────────────

// Where the cash-application evidence for a payment↔gift booking came from.
// `quickbooks` is the anchor (the staged QB record that settled the gift);
// `stripe` / `donorbox` rows additionally carry the originating charge /
// donation id (enforced by a CHECK on payment_applications).
export const paymentApplicationEvidenceSourceEnum = pgEnum(
  "payment_application_evidence_source",
  ["quickbooks", "stripe", "donorbox"],
);

// How a cash-application row was established (audit + UI badge).
//   system           — booked automatically by a sync / reconcile worker
//   system_confirmed — auto-booked, then confirmed by a human
//   human            — a human created the application in the reconciler
export const paymentApplicationMatchMethodEnum = pgEnum(
  "payment_application_match_method",
  ["system", "system_confirmed", "human"],
);

// Whether a ledger row COUNTS toward donor credit or merely corroborates it.
//   counted       — the money trail; included in the book-once SUM and every tie
//                   derivation (today's only kind).
//   corroborating — a non-counted audit annotation (the future home of
//                   gift_evidence_links, Decision 2); never enters the SUM.
// Additive now (final-shaped schema); only `counted` rows are written/backfilled
// this phase. The corroborating fold is a later human-gated task.
export const paymentApplicationLinkRoleEnum = pgEnum(
  "payment_application_link_role",
  ["counted", "corroborating"],
);

// The application's confirmation lifecycle.
//   proposed  — a suggested (not yet human-confirmed) application.
//   confirmed — an application that stands (auto-applied high-confidence or
//               human-confirmed). All rows written this phase are `confirmed`
//               (mirrors today's behavior: a ledger row is only booked on a
//               settle/mint/link, never on a mere proposal).
export const paymentApplicationLifecycleEnum = pgEnum(
  "payment_application_lifecycle",
  ["proposed", "confirmed"],
);

// ---- Settlement links (Plane 1: Stripe payout ↔ QB deposit) ----
// docs/reconciliation-design.md §4.3. Batch-to-batch settlement is structurally
// different from the Plane-2 unit↔gift ledger (a settlement row has no donor and
// no amount split), so it gets its own purpose-built link table.
//
// The settlement lifecycle (replaces the 7-value `stripe_payouts
// .qb_reconciliation_status` going forward):
//   proposed  — the system proposed a payout↔deposit tie; awaiting human confirm.
//   confirmed — the tie is confirmed (auto-confirmed or human-confirmed). This is
//               the single "the payout landed as this deposit" fact; whether the
//               coarse deposit gift is superseded by per-charge Stripe gifts is a
//               separate Plane-2 concern (the §4.3 supersede rule), NOT a settlement
//               status. (Legacy confirmed_excluded/_keep/_replace/_reconciled all
//               map here — the tie WAS confirmed.)
//   exempt    — the payout is intentionally not settled against a QB deposit.
export const settlementLinkLifecycleEnum = pgEnum("settlement_link_lifecycle", [
  "proposed",
  "confirmed",
  "exempt",
]);

// Who established the settlement link.
//   system           — a system-proposed tie (lifecycle `proposed`).
//   system_confirmed — a tie confirmed programmatically / without an attributable
//                      human (e.g. the 0089 backfill of legacy confirmed rows that
//                      predate `qb_reconciliation_confirmed_by_user_id` capture).
//   human            — a person confirmed it in the reconciliation queue
//                      (confirmed_by_user_id populated).
export const settlementLinkProvenanceEnum = pgEnum(
  "settlement_link_provenance",
  ["system", "system_confirmed", "human"],
);

// ---- Schools enums (mirrored from Airtable "Schools" base) ----
export const schoolStatusEnum = pgEnum("school_status", [
  "emerging",
  "open",
  "paused",
  "closing",
  "permanently_closed",
  "disaffiliating",
  "disaffiliated",
  "placeholder",
  "abandoned",
]);

export const governanceModelEnum = pgEnum("governance_model", [
  "independent",
  "district",
  "charter",
  "exploring_charter",
  "community_partnership",
]);

export const pronounsEnum = pgEnum("pronouns", [
  "he_him_his",
  "she_her_hers",
  "they_them_theirs",
  "other",
]);

// ---- Email sync enums ----
// Whether a synced Gmail message was sent by the mailbox owner or
// received in their mailbox. Decided by comparing the From header
// against the connected Google account email.
export const emailDirectionEnum = pgEnum("email_direction", [
  "sent",
  "received",
]);

// ---- Interaction enums ----
// Kind of touch the fundraising team logged. Manual entries only —
// Gmail / Calendar syncs land in their own tables, not here.
export const interactionKindEnum = pgEnum("interaction_kind", [
  "meeting",
  "phone_call",
  "video_call",
  "conference",
  "other",
]);

// ---- Email intelligence enums ----
// Kind of actionable signal extracted from a synced email. Each row in
// email_proposals carries exactly one kind. See emailProposals.ts for
// the payload shape per kind.
export const emailProposalKindEnum = pgEnum("email_proposal_kind", [
  "linkedin_job_change",
  "auto_responder_move",
  "bounce_invalid",
  "bounce_soft",
  "signature_update",
  "grant_opportunity",
  // Outbound staff email that looks like a thank-you acknowledgment for
  // a specific gift (subject contains "thank", recipient is a funder
  // contact, sent within 30d of the gift, carries ≥1 document attachment).
  // Accept handler stamps gifts_and_payments.thank_you_sent_at +
  // thank_you_email_message_id; reviewer can also override the
  // candidate gift inside the dialog. Payload: { giftId, fromEmail,
  // toEmail, subject, sentAt, attachmentIds[] }.
  "thank_you_acknowledgment",
  // AI-suggested action derived from the shared "Wildflower updates" note
  // (see wildflowerUpdates.ts). Two flavors, distinguished by
  // payload.flavor:
  //   - "donor_outreach": accept mints a cultivation next-step task for the
  //     target donor about a current Wildflower theme. Payload:
  //     { flavor, title, description?, rationale, sourceProposalId }.
  //   - "note_revision": accept overwrites the shared note's content after a
  //     human reviews (and may edit) the proposed text. Payload:
  //     { flavor, proposedContent, rationale, sourceProposalId }.
  // These rows are materialized already-analyzed (no further AI), so they
  // carry an empty proposedActions array and their own accept branch.
  "wildflower_update",
]);

// Lifecycle of an email_proposals row. `pending` is the review queue;
// `applied` means the accept handler successfully ran the side-effect
// (e.g. marked email invalid, updated person record); `rejected` and
// `ignored` are user-driven dismissals (rejected = "wrong / bad
// signal", ignored = "right but I don't want to act on it now").
export const emailProposalStatusEnum = pgEnum("email_proposal_status", [
  "pending",
  "applied",
  "rejected",
  "ignored",
]);

// Lifecycle of an email-intelligence AI-prompt version.
//   - `active`   : the single live version the proposal pipeline reads.
//   - `draft`    : an AI-generated candidate awaiting admin review. At
//                  most one outstanding at a time; approving it makes it
//                  active, discarding deletes it.
//   - `archived` : a previously-active version retained for history /
//                  revert. Never destroyed.
export const emailIntelPromptStatusEnum = pgEnum("email_intel_prompt_status", [
  "active",
  "draft",
  "archived",
]);

// Where a prompt version came from.
//   - `hand_edited`  : an admin typed/edited the text directly.
//   - `ai_generated` : drafted by the "Generate AI update" flow from
//                      recent reviewer feedback.
//   - `reverted`     : a copy of an earlier version re-promoted to active.
export const emailIntelPromptOriginEnum = pgEnum("email_intel_prompt_origin", [
  "hand_edited",
  "ai_generated",
  "reverted",
]);

// The detected-signal family an email-intelligence REVIEW prompt is scoped
// to. Distinct from email_proposal_kind: `bounce` collapses the two bounce
// kinds (bounce_invalid + bounce_soft), and `wildflower_update` is
// intentionally absent — those rows are materialized already-analyzed and
// never go through the AI review step. See signalTypeForKind() in the
// api-server emailIntelPrompts lib for the kind → signal-type mapping.
export const emailIntelSignalTypeEnum = pgEnum("email_intel_signal_type", [
  "linkedin_job_change",
  "auto_responder_move",
  "bounce",
  "signature_update",
  "grant_opportunity",
  "thank_you_acknowledgment",
]);

// Which review phase a prompt drives. The hidden action-proposing core
// (how to act) is not a phase — it is hard-coded and never editable.
//   - `accuracy`    : is the detected signal actually correct?
//   - `suppression` : even if accurate, is it worth a human's attention?
export const emailIntelReviewPhaseEnum = pgEnum("email_intel_review_phase", [
  "accuracy",
  "suppression",
]);

// ---- People-entity-role enums ----
export const peopleEntityRoleConnectionEnum = pgEnum(
  "people_entity_role_connection",
  [
    "employee",
    "principal",
    "board_member",
    "partner",
    "professor",
    "donor_advisor",
    "elected_official",
  ],
);

// Task type. `general` is the historical default — a manual to-do.
// `reporting_deadline` is created from the "report deadlines" prompt
// that fires when an opportunity flips to pledge/cash_in; the
// reporting-deadlines dashboard filters on this kind so the
// org-wide grant-reporting view stays separate from per-user task
// noise. `thank_you_followup` is reserved for the future "gift had
// no linked thank-you within N days" nudge (not used in v1).
export const taskKindEnum = pgEnum("task_kind", [
  "general",
  "reporting_deadline",
  "thank_you_followup",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "waiting",
  "done",
  "cancelled",
]);

export const taskProposalStatusEnum = pgEnum("task_proposal_status", [
  "pending",
  "accepted",
  "dismissed",
]);

// ──────────────────────────────────────────────────────────────────
// QuickBooks Online payment sync
// ──────────────────────────────────────────────────────────────────

// Which QuickBooks "incoming money" entity a staged payment was pulled
// from. Used together with the QB entity id for idempotent dedupe.
export const quickbooksEntityTypeEnum = pgEnum("quickbooks_entity_type", [
  "sales_receipt",
  "payment",
  "deposit",
]);

// The kind of QuickBooks name a staged payment's payer resolves to. Pulled
// verbatim from the QB entity ref (CustomerRef on SalesReceipt/Payment, the
// deposit line's DepositLineDetail.Entity ref on a deposit line) and normalized
// to lower snake_case. A `vendor`/`employee` payer is a strong "this is not a
// donation" signal for the reconciler; `customer` is the normal donor case.
// NULL when QuickBooks supplied no payer ref (e.g. some bare deposit lines).
export const quickbooksPayerTypeEnum = pgEnum("quickbooks_payer_type", [
  "vendor",
  "customer",
  "employee",
]);

// Lifecycle of a staged QuickBooks payment in the review queue.
//   pending  — awaiting fundraiser review (default)
//   approved — turned into a gifts_and_payments row (createdGiftId set)
//   rejected — explicitly discarded; kept so re-sync won't re-stage it
//   excluded — auto-filtered noise (zero/loan/membership); kept + auditable,
//              hidden from the default queue, re-includable to pending. Cannot
//              be approved/rejected/resolved while excluded.
//   reconciled — terminal: this evidence row (a QB deposit/payment OR a Stripe
//              charge) has been permanently tied to a CRM gift, which is the
//              single source of truth. Kept + queryable + linked, dropped from
//              the work queue. NOT noise (distinct from `excluded`); never
//              auto-applied — set only on human confirm in the reconciliation
//              flow. The evidence row never becomes a gift and is never archived.
export const stagedPaymentStatusEnum = pgEnum("staged_payment_status", [
  "pending",
  "approved",
  "rejected",
  "excluded",
  "reconciled",
]);

// Why a staged QuickBooks payment was filtered out of the review queue. Grouped
// into the families the finance team thinks in (see the UI label map). NOTE the
// three LEGACY values `loan`, `government_reimbursement`, `fiscally_sponsored`:
// the classifier NO LONGER emits any of them, but they are RETAINED as valid
// enum members so historical rows stay readable until a reviewed prod migration
// re-codes them and (optionally) recreates the enum without them.
//
// — Not real money —
//   zero_amount              — amount is null or <= 0
//   note_payable             — a liability booking (Note Payable account), not a real cash receipt
// — Earned & other income (real revenue, not a gift) —
//   membership               — school membership contributions (matched by QB item / income account)
//   earned_income            — fees-for-service / program revenue (4020 Services - Earned Income) + guaranty fees; never a gift
//   interest                 — bank/investment income (Interest Earned 4010 + Realized Gain/Loss on Investments 4040)
//   other_revenue            — clear non-gifts posted to Other Revenue (4030): credit-card rewards / bank-account activity (matched by memo)
// — A payment, but not revenue (money returning / not income) —
//   loan_repayment           — principal/interest returning on loans Wildflower MADE ("Loans to Schools" account, "repayment" marker)
//   loan_proceeds            — borrowed funds coming in (e.g. "PPP Loan Received"); a liability, not income
//   expense_refund           — refunds of the org's own expenses (vendor overpayments, ERC tax refunds, etc.); not a contribution
//   tax_refund               — payroll-tax / tax / insurance refunds (unemployment tax, workers-comp, etc.)
//   insurance                — COBRA / insurance-premium reimbursements (BASICCOBRA marker); never a gift
//   expensify                — Expensify expense-reimbursement activity ("expensify" marker); never a gift
//   returned_wire            — a wire transfer the org sent that bounced back ("returned wire" marker); not an incoming gift
// — Not incoming money —
//   miscoded_withdrawal      — an outflow QuickBooks recorded as a deposit/payment (manual-only)
//   intercompany_transfer    — movement of money between the org's own entities/accounts; not a gift (manual-only)
// — Already booked elsewhere (would double-count) —
//   processor_payout         — a Stripe (processor) NET-payout lump that has been
//                              reconciled to its individual Stripe charges in the
//                              Stripe↔QB reconciliation queue. Excluded so the same
//                              money isn't booked twice (the per-charge gross Stripe
//                              gifts are the precise record), kept + linked for audit.
//                              Set ONLY on human confirm — never auto-applied.
// — Other (manual catch-all) —
//   other                    — catch-all manual exclusion when no specific category fits (manual-only)
//
// — LEGACY (no longer emitted; retained for historical rows only) —
//   loan                     — old overloaded "school loan activity"; split into loan_repayment / loan_proceeds / note_payable / earned_income(guaranty)
//   government_reimbursement — government program reimbursements (CSP marker); now KEPT IN QUEUE and minted as a gift with counts_toward_goal=false
//   fiscally_sponsored       — pass-through money for a sponsored project; now KEPT IN QUEUE, attributed via detectEntity + surfaced in the "without corresponding gift" worklist
export const stagedPaymentExclusionReasonEnum = pgEnum(
  "staged_payment_exclusion_reason",
  [
    "zero_amount",
    "loan",
    "membership",
    "interest",
    "government_reimbursement",
    "tax_refund",
    "other_revenue",
    "earned_income",
    "fiscally_sponsored",
    "intercompany_transfer",
    "other",
    "insurance",
    "expense_refund",
    "expensify",
    "returned_wire",
    "processor_payout",
    // Added by task #363 (loan split + new families).
    "loan_repayment",
    "loan_proceeds",
    "note_payable",
    "miscoded_withdrawal",
  ],
);

// Result of scoring a staged payment against CRM donors / existing gifts.
//   matched   — high-confidence; the system auto-applied it (or a human
//               confirmed it). Lives in the "Auto-matched" review queue until
//               a human looks at it (autoApplied=true, matchConfirmedAt null)
//               or is fully done (human-confirmed).
//   suggested — a plausible candidate was found but below the auto-apply
//               threshold; surfaced as a hint in the "Needs review" queue but
//               NOT applied (treated as unmatched until a human acts).
//   unmatched — no plausible candidate at all; "Needs review" queue.
export const stagedPaymentMatchStatusEnum = pgEnum(
  "staged_payment_match_status",
  ["matched", "suggested", "unmatched"],
);

// How a staged payment's donor/gift match was derived (audit + UI badge).
//   email            — exact email hit (strongest)
//   name             — fuzzy/exact CRM name hit (trigram)
//   name_amount_date — name plus corroborating amount + date proximity
//   amount_date      — DEPRECATED (unused): the matcher no longer guesses a
//                      donor purely from amount + date proximity to an unrelated
//                      gift. Value retained to avoid a destructive enum drop.
//   memo             — donor name parsed out of a free-text memo/reference
//   intermediary     — payer resolved to a payment intermediary, donor via memo
//   manual           — a human picked the donor/gift in the reconciler
export const stagedPaymentMatchMethodEnum = pgEnum(
  "staged_payment_match_method",
  [
    "email",
    "name",
    "name_amount_date",
    "amount_date",
    "memo",
    "intermediary",
    "manual",
  ],
);

// Whether a staged payment's exclusion classification was set by the
// re-runnable auto-classifier (`auto`) or pinned by a human (`manual`).
// The classifier never overwrites a `manual` row, so a manual include /
// reclassify survives every re-run.
export const stagedPaymentClassificationSourceEnum = pgEnum(
  "staged_payment_classification_source",
  ["auto", "manual"],
);

// Whether a staged payment's Wildflower-entity attribution was derived by the
// re-runnable `detectEntity` marker classifier (`auto`) or pinned by a human
// (`manual`). A manual attribution survives every re-sync / reclassify: the
// upsert and the reclassifier never overwrite the entity of a `manual` row.
// Needed because some money (e.g. "Sunlight") is intentionally NOT
// auto-attributed and must be filed by hand, and the broad marker match can
// occasionally misattribute and need a human correction.
export const stagedPaymentEntitySourceEnum = pgEnum(
  "staged_payment_entity_source",
  ["auto", "manual"],
);

// WHERE a staged payment's incoming money actually came from / how it was
// rendered, as a first-class queryable + human-correctable origin dimension —
// DISTINCT from qbPaymentMethod (the QB PaymentMethodRef instrument like
// "Visa"/"Check") and from the DERIVED reconciliation "funding lane" (which
// tracks reconcile PROGRESS, not origin). Auto-seeded at ingest from existing
// signals (Stripe payout evidence, matched payment-intermediary type, payment
// method, memo) by the pure `detectFundingSource` helper, and correctable by a
// human. NULL on the column = not yet determined / unknown; `other` = a known
// origin outside this list.
export const stagedPaymentFundingSourceEnum = pgEnum(
  "staged_payment_funding_source",
  [
    "stripe",
    "brokerage",
    "daf",
    "donorbox",
    "paypal",
    "wire_ach",
    "check",
    "cash",
    "employer_match",
    "other",
  ],
);

// Whether a staged payment's funding-source value was derived by the
// re-runnable `detectFundingSource` helper (`auto`, default) or pinned by a
// human (`manual`). Mirrors entitySource / classificationSource: a `manual`
// value is review state — the QB upsert and the re-runnable reclassifier never
// overwrite the funding source of a `manual` row, so a hand-set / corrected
// origin survives every re-pull.
export const stagedPaymentFundingSourceProvenanceEnum = pgEnum(
  "staged_payment_funding_source_provenance",
  ["auto", "manual"],
);

// ──────────────────────────────────────────────────────────────────
// Donorbox donation sync (enrichment + non-Stripe new-money review)
// ──────────────────────────────────────────────────────────────────

// Why a non-Stripe Donorbox donation was excluded from the new-money review
// worklist (a human decided it should NOT mint a new CRM gift). Stripe-type
// Donorbox donations are enrichment-only and never enter the worklist, so they
// never carry a reason.
//   already_booked — the money is already in the CRM via another source
//                    (a QuickBooks deposit, a Stripe charge, a hand-entered gift).
//   duplicate      — a duplicate of another Donorbox donation already handled.
//   not_a_gift     — a test/refunded/non-donation row that is not real new money.
//   other          — catch-all manual exclusion when no specific category fits.
export const donorboxExclusionReasonEnum = pgEnum("donorbox_exclusion_reason", [
  "already_booked",
  "duplicate",
  "not_a_gift",
  "other",
]);

// Lifecycle of a Stripe refund/chargeback proposal raised against a Stripe
// staged charge whose money is already booked into a CRM gift (INV-13). The
// propagation is propose-then-confirm: the sync worker only ever RAISES a
// `proposed`; a human confirms (`applied`) or dismisses (`dismissed`) it.
//   none      — no refund/dispute, or no linked gift to propagate to.
//   proposed  — a refund/chargeback was detected; awaiting human confirm.
//   applied   — the human confirmed; the gift was reversed/reduced.
//   dismissed — the human chose not to propagate this refund to the gift.
export const stripeRefundPropagationStatusEnum = pgEnum(
  "stripe_refund_propagation_status",
  ["none", "proposed", "applied", "dismissed"],
);

// What kind of Stripe reversal a refund proposal represents.
//   full_refund    — the charge was refunded in full ⇒ reverse (archive) gift.
//   partial_refund — the charge was partially refunded ⇒ reduce gift amount.
//   chargeback     — the charge was disputed ⇒ reverse (archive) gift.
export const stripeRefundKindEnum = pgEnum("stripe_refund_kind", [
  "full_refund",
  "partial_refund",
  "chargeback",
]);

// Where a CRM gift's FINAL `amount` was last sourced from (provenance for the
// reconciliation model in which the CRM gift is the single source of truth).
//   human      — hand-entered by a fundraiser (default; the pre-reconciliation
//                state of every existing gift).
//   stripe     — stamped from a Stripe charge (gross, per-donor). Stripe WINS
//                whenever a charge exists for the gift.
//   quickbooks — stamped from a QuickBooks staged row. Used ONLY when there is
//                no Stripe charge behind the gift.
// The matching pointer column on gifts_and_payments is enforced XOR with this
// value by a CHECK constraint (human ⇒ no pointer).
export const giftFinalAmountSourceEnum = pgEnum("gift_final_amount_source", [
  "human",
  "stripe",
  "quickbooks",
]);

// Derived (persisted) signal of whether an on-books gift reconciles to a
// QuickBooks record. Computed from the off-books exemption flags + the gift's
// QuickBooks linkage + the gross-vs-net fee tolerance — never hand-set.
//   exempt          — off-books (fiscal-sponsor era OR designated-to-school);
//                     not subject to the QB-tie requirement.
//   tied            — reconciles to a QuickBooks record within fee tolerance
//                     (or is Stripe-sourced, whose money lands in QB at the
//                     payout level rather than per-gift).
//   amount_mismatch — linked to a QuickBooks record but the amount falls
//                     outside the gross-vs-net fee band.
//   missing         — on-books with no QuickBooks evidence at all.
export const giftQuickbooksTieEnum = pgEnum("gift_quickbooks_tie", [
  "exempt",
  "tied",
  "amount_mismatch",
  "missing",
]);

// Action an admin-editable QuickBooks handling rule performs when it matches an
// incoming staged payment (see quickbooks_handling_rules):
//   exclude             — mark the row excluded with one of the existing
//                         staged_payment_exclusion_reason categories (noise).
//   auto_create_approve — mint a gift attributed to the rule's target
//                         organization, allocate it (target intended usage /
//                         fundable project), match the staged row to that gift,
//                         and land it in the auto (approved + auto-applied) queue.
export const quickbooksRuleActionEnum = pgEnum("quickbooks_rule_action", [
  "exclude",
  "auto_create_approve",
]);

// ──────────────────────────────────────────────────────────────────
// Grant Leads (team-shared, cross-inbox grant opportunity queue)
// ──────────────────────────────────────────────────────────────────

// Lifecycle of a team-shared grant lead row.
//   new       — freshly extracted; no one has acted on it yet
//   claimed   — a team member has taken ownership (assigneeUserId is set)
//   converted — turned into a real opportunity (convertedOpportunityId is set)
//   archived  — dismissed for everyone; stays in DB for history
export const grantLeadStatusEnum = pgEnum("grant_lead_status", [
  "new",
  "claimed",
  "converted",
  "archived",
]);

// ──────────────────────────────────────────────────────────────────
// Cleanup queue (records flagged for manual data cleanup)
// ──────────────────────────────────────────────────────────────────

// Lifecycle of a cleanup-queue item.
//   open      — needs attention; shows in the default queue view
//   resolved  — the underlying record was cleaned up by hand
//   dismissed — judged not worth fixing / a false flag
// Both resolved and dismissed drop out of the default view.
export const cleanupQueueStatusEnum = pgEnum("cleanup_queue_status", [
  "open",
  "resolved",
  "dismissed",
]);

// ──────────────────────────────────────────────────────────────────
// Donation Coding Form import (one-time FY24/FY25/FY26 + Girasol Act-60)
// ──────────────────────────────────────────────────────────────────

// Lifecycle of a parsed coding-form row in the admin import review queue.
//   pending  — parsed + matched; awaiting human review/apply (default)
//   applied  — the reviewer applied the approved values into the CRM
//   skipped  — the reviewer dismissed the row (nothing to apply)
// Re-running the importer never resets a row out of applied/skipped.
export const codingFormRowStatusEnum = pgEnum("coding_form_row_status", [
  "pending",
  "applied",
  "skipped",
]);
