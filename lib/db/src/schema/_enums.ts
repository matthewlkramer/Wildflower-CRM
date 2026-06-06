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

// Stage values map to a default win-probability in the UI/API layer.
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
]);

export const opportunityConditionalEnum = pgEnum("opportunity_conditional", [
  "unconditional",
  "conditional_unspecified",
  "reimbursable",
  "conditional_on_funder_determination",
  "conditional_on_target",
]);

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
export const stagedPaymentStatusEnum = pgEnum("staged_payment_status", [
  "pending",
  "approved",
  "rejected",
  "excluded",
]);

// Why a staged QuickBooks payment was auto-excluded from the review queue.
//   zero_amount              — amount is null or <= 0
//   loan                     — school loan activity (loan account, repayment, guaranty fee)
//   membership               — school membership dues (matched by QB item / income account)
//   interest                 — bank/investment income (Interest Earned 4010 + Realized Gain/Loss on Investments 4040)
//   government_reimbursement — government grant reimbursements (exact payer name, e.g. "CSP")
//   tax_refund               — payroll-tax / tax / insurance refunds (unemployment tax, workers-comp, etc.)
//   other_revenue            — clear non-gifts posted to Other Revenue (4030): credit-card rewards / bank-account activity (matched by memo)
//   earned_income            — fees-for-service / program revenue (4020 Services - Earned Income); never a gift
//   intercompany_transfer    — movement of money between the org's own entities/accounts; not a gift (manual-only)
//   other                    — catch-all manual exclusion when no specific category fits (manual-only)
//   insurance                — COBRA / insurance-premium reimbursements (BASICCOBRA marker); never a gift
//   expense_refund           — refunds of the org's own expenses (vendor overpayments, ERC tax refunds, etc.); not a contribution
//   expensify                — Expensify expense-reimbursement activity ("expensify" marker); never a gift
//   returned_wire            — a wire transfer the org sent that bounced back ("returned wire" marker); not an incoming gift
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
//   amount_date      — amount + date proximity to an existing CRM gift
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
