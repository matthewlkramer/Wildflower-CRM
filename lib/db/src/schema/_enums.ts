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
  "funder",
  "non_funding_organization",
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

export const opportunityStatusEnum = pgEnum("opportunity_status", [
  "open",
  "won",
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

// ---- Funder enums ----
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

export const enthusiasmEnum = pgEnum("enthusiasm", [
  "advocate",
  "supportive",
  "warm",
  "neutral",
  "unsupportive",
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

// ---- Organization enums ----
export const organizationTypeEnum = pgEnum("organization_type", [
  "advocacy_membership_lobbyist",
  "authorizer",
  "cmo",
  "capital_provider",
  "government",
  "corporation",
  "education_vendor",
  "elected_official",
  "higher_ed",
  "investor",
  "law_firm",
  "media",
  "nonprofit",
  "philanthropic_advisor",
  "real_estate",
  "school",
  "school_district",
  "school_network",
  "small_business_consulting",
  "tribal",
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
  "verbal_commitment",
  "written_commitment",
  "cash_in",
]);

export const opportunityConditionalEnum = pgEnum("opportunity_conditional", [
  "unconditional",
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
