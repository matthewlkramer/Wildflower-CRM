import type { BulkField } from "@/components/bulk-edit-dialog";
import {
  formatCapacity,
} from "@/lib/format";

/**
 * Per-entity bulk-edit field configs.
 *
 * Column fields (FK/enum/boolean) live on the parent row. The
 * `string-array` kind reconciles a related allocation table on the
 * server side (pledge_allocations for opps, gift_allocations for
 * gifts) with a replace/append mode toggle. Replace is flagged as
 * destructive so it routes through the confirmation gate.
 */

export const PEOPLE_BULK_FIELDS: ReadonlyArray<BulkField> = [
  { kind: "owner", key: "ownerUserId", label: "Owner", nullable: true },
  {
    kind: "region",
    key: "currentHomeRegionId",
    label: "Current home region",
    nullable: true,
  },
  {
    kind: "enum",
    key: "capacityRating",
    label: "Capacity",
    nullable: true,
    options: [
      { value: "tier_1k_10k", label: formatCapacity("tier_1k_10k") ?? "$1K–10K" },
      { value: "tier_10k_50k", label: formatCapacity("tier_10k_50k") ?? "$10K–50K" },
      { value: "tier_50k_250k", label: formatCapacity("tier_50k_250k") ?? "$50K–250K" },
      { value: "tier_250k_1m", label: formatCapacity("tier_250k_1m") ?? "$250K–1M" },
      { value: "tier_1m_plus", label: formatCapacity("tier_1m_plus") ?? "$1M+" },
    ],
  },
  {
    kind: "enum",
    key: "connectionStatus",
    label: "Connection status",
    nullable: true,
    options: [
      { value: "connected", label: "Connected" },
      { value: "have_a_connector", label: "Have a connector" },
      { value: "no_connection", label: "No connection" },
    ],
  },
  {
    kind: "enum",
    key: "enthusiasm",
    label: "Enthusiasm",
    nullable: true,
    options: [
      { value: "7-advocate", label: "7-Advocate" },
      { value: "6-supportive", label: "6-Supportive" },
      { value: "5-warm", label: "5-Warm" },
      { value: "4-neutral", label: "4-Neutral" },
      { value: "3-cool", label: "3-Cool" },
      { value: "2-unsupportive", label: "2-Unsupportive" },
      { value: "1-hostile", label: "1-Hostile" },
    ],
  },
  {
    kind: "enum",
    key: "priority",
    label: "Priority tier",
    nullable: true,
    options: [
      { value: "top", label: "Top" },
      { value: "high", label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low", label: "Low" },
    ],
  },
  {
    kind: "boolean",
    key: "deceased",
    label: "Deceased",
    trueLabel: "Deceased",
    falseLabel: "Living",
    destructiveValue: true,
  },
  {
    // Newsletter on/off. Changes flow through the same outbound Flodesk
    // sync the single-person edit uses (server afterApply hook).
    kind: "boolean",
    key: "newsletter",
    label: "Newsletter",
    trueLabel: "Subscribed",
    falseLabel: "Not subscribed",
  },
  {
    kind: "string-array",
    key: "interestsThematic",
    modeKey: "interestsThematicMode",
    label: "Thematic interests",
    source: "interestsThematic",
  },
  {
    kind: "string-array",
    key: "interestsAges",
    modeKey: "interestsAgesMode",
    label: "Age interests",
    source: "interestsAges",
  },
  {
    kind: "string-array",
    key: "interestsGovModels",
    modeKey: "interestsGovModelsMode",
    label: "Governance-model interests",
    source: "interestsGovModels",
  },
  {
    kind: "string-array",
    key: "regionIds",
    modeKey: "regionIdsMode",
    label: "Region interests",
    source: "regions",
  },
];

export const ORGANIZATIONS_BULK_FIELDS: ReadonlyArray<BulkField> = [
  { kind: "owner", key: "ownerUserId", label: "Owner", nullable: true },
  {
    kind: "enum",
    key: "activeStatus",
    label: "Active status",
    nullable: true,
    options: [
      { value: "active", label: "Active" },
      { value: "spenddown", label: "Spend-down" },
      { value: "defunct", label: "Defunct", destructive: true },
    ],
  },
  {
    kind: "enum",
    key: "connectionStatus",
    label: "Connection status",
    nullable: true,
    options: [
      { value: "connected", label: "Connected" },
      { value: "have_a_connector", label: "Have a connector" },
      { value: "no_connection", label: "No connection" },
    ],
  },
  {
    kind: "enum",
    key: "capacityRating",
    label: "Capacity",
    nullable: true,
    options: [
      { value: "tier_1k_10k", label: formatCapacity("tier_1k_10k") ?? "$1K–10K" },
      { value: "tier_10k_50k", label: formatCapacity("tier_10k_50k") ?? "$10K–50K" },
      { value: "tier_50k_250k", label: formatCapacity("tier_50k_250k") ?? "$50K–250K" },
      { value: "tier_250k_1m", label: formatCapacity("tier_250k_1m") ?? "$250K–1M" },
      { value: "tier_1m_plus", label: formatCapacity("tier_1m_plus") ?? "$1M+" },
    ],
  },
  {
    kind: "enum",
    key: "enthusiasm",
    label: "Enthusiasm",
    nullable: true,
    options: [
      { value: "7-advocate", label: "7-Advocate" },
      { value: "6-supportive", label: "6-Supportive" },
      { value: "5-warm", label: "5-Warm" },
      { value: "4-neutral", label: "4-Neutral" },
      { value: "3-cool", label: "3-Cool" },
      { value: "2-unsupportive", label: "2-Unsupportive" },
      { value: "1-hostile", label: "1-Hostile" },
    ],
  },
  {
    kind: "enum",
    key: "priority",
    label: "Priority tier",
    nullable: true,
    options: [
      { value: "top", label: "Top" },
      { value: "high", label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low", label: "Low" },
    ],
  },
  {
    kind: "enum",
    key: "strategicAlignment",
    label: "Strategic alignment",
    nullable: true,
    options: [
      { value: "high", label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low", label: "Low" },
    ],
  },
  {
    kind: "boolean",
    key: "issuesGrants",
    label: "Makes grants",
    trueLabel: "Makes grants",
    falseLabel: "Does not make grants",
  },
  {
    kind: "boolean",
    key: "makesPris",
    label: "Makes PRIs",
    trueLabel: "Makes PRIs",
    falseLabel: "Does not make PRIs",
  },
  {
    kind: "enum",
    key: "entityType",
    label: "Funder subtype",
    nullable: true,
    options: [
      { value: "family_foundation", label: "Family foundation" },
      { value: "institutional_foundation", label: "Institutional foundation" },
      { value: "corporate_foundation", label: "Corporate foundation" },
      { value: "community_foundation", label: "Community foundation" },
      { value: "bank_foundation", label: "Bank foundation" },
      { value: "family_office_trust", label: "Family office / trust" },
      { value: "intermediary", label: "Intermediary" },
      { value: "government", label: "Government" },
      { value: "nonprofit", label: "Nonprofit" },
      { value: "corporation", label: "Corporation" },
      { value: "capital_provider", label: "Capital provider" },
      { value: "philanthropic_advisor", label: "Philanthropic advisor" },
      { value: "cdfi", label: "CDFI" },
      { value: "education_forprofit", label: "Education (for-profit)" },
      { value: "competition", label: "Competition" },
      { value: "public_private", label: "Public-private" },
      { value: "daf_platform", label: "DAF platform" },
      { value: "platform", label: "Platform" },
    ],
  },
];

export const HOUSEHOLDS_BULK_FIELDS: ReadonlyArray<BulkField> = [
  {
    kind: "boolean",
    key: "active",
    label: "Active",
    trueLabel: "Active",
    falseLabel: "Inactive",
    destructiveValue: false,
  },
];

export const OPPORTUNITIES_BULK_FIELDS: ReadonlyArray<BulkField> = [
  { kind: "owner", key: "ownerUserId", label: "Owner", nullable: true },
  {
    // `status` is fully calculated server-side; the only settable override
    // is `lossType` (clear it via — None — to return the row to the
    // calculated funnel). Setting it CLOSES rows, and the API requires an
    // actualCompletionDate on any row newly closed — so picking a value
    // auto-enables the date field below (defaulted to today, editable) and
    // the date is required at submit. Rows already closed are exempt
    // server-side.
    kind: "enum",
    key: "lossType",
    label: "Loss type",
    nullable: true,
    options: [
      { value: "lost", label: "Lost", destructive: true },
      { value: "dormant", label: "Dormant", destructive: true },
    ],
    requiresDate: { key: "actualCompletionDate", label: "Actual completion date" },
  },
  {
    kind: "enum",
    key: "stage",
    label: "Stage",
    nullable: true,
    options: [
      { value: "cold_lead", label: "Cold lead" },
      { value: "warm_lead", label: "Warm lead" },
      { value: "in_conversation", label: "In conversation" },
      { value: "convince", label: "Convince" },
      { value: "probable_renewal", label: "Probable renewal" },
      { value: "verbal_confirmation", label: "Verbal confirmation" },
    ],
  },
  {
    kind: "enum",
    key: "type",
    label: "Type",
    nullable: true,
    options: [
      { value: "solicitation", label: "Solicitation" },
      { value: "renewal", label: "Renewal" },
      { value: "open_application", label: "Open application" },
    ],
  },
  {
    kind: "date",
    key: "actualCompletionDate",
    label: "Actual completion date",
    nullable: true,
  },
  {
    kind: "date",
    key: "projectedCloseDate",
    label: "Projected close date",
    nullable: true,
  },
  {
    kind: "date",
    key: "applicationDeadline",
    label: "Application deadline",
    nullable: true,
  },
  {
    kind: "string-array",
    key: "entities",
    modeKey: "entitiesMode",
    label: "Entities",
    source: "entities",
  },
  {
    kind: "string-array",
    key: "coveredFiscalYears",
    modeKey: "coveredFiscalYearsMode",
    label: "Covered fiscal years",
    source: "fiscalYears",
  },
  {
    kind: "intended-usage",
    key: "intendedUsage",
    projectKey: "fundableProjectId",
    label: "Intended usage",
    projectLabel: "Fundable project",
    options: [
      { value: "gen_ops", label: "Gen ops" },
      { value: "growth", label: "Growth" },
      { value: "school_startup", label: "School startup" },
      { value: "teacher_training", label: "Teacher training" },
      { value: "project", label: "Project" },
    ],
  },
];

export const GIFTS_BULK_FIELDS: ReadonlyArray<BulkField> = [
  { kind: "owner", key: "ownerUserId", label: "Owner", nullable: true },
  {
    kind: "enum",
    key: "type",
    label: "Gift type",
    nullable: true,
    options: [
      { value: "standard_gift", label: "Standard gift" },
      { value: "pledge_payment", label: "Pledge payment" },
      { value: "directed_gift", label: "Directed gift" },
      { value: "loan_fund_investment", label: "Loan fund investment" },
      { value: "matching_gift", label: "Matching gift" },
      { value: "reimbursement", label: "Reimbursement" },
    ],
  },
  {
    kind: "enum",
    key: "paymentMethod",
    label: "Payment method",
    nullable: true,
    options: [
      { value: "ach", label: "ACH" },
      { value: "check", label: "Check" },
      { value: "wire", label: "Wire" },
      { value: "stock", label: "Stock" },
      { value: "donor_box", label: "Donor box" },
      { value: "daf_ach", label: "DAF ACH" },
      { value: "daf_check", label: "DAF check" },
      { value: "daf_bill_com", label: "DAF bill.com" },
    ],
  },
  {
    kind: "date",
    key: "dateReceived",
    label: "Date received",
    nullable: true,
  },
  {
    kind: "string-array",
    key: "entityIds",
    modeKey: "entityIdsMode",
    label: "Entities",
    source: "entities",
  },
  {
    kind: "string-array",
    key: "grantYears",
    modeKey: "grantYearsMode",
    label: "Grant years",
    source: "fiscalYears",
  },
  {
    kind: "intended-usage",
    key: "intendedUsage",
    projectKey: "fundableProjectId",
    label: "Intended usage",
    projectLabel: "Fundable project",
    options: [
      { value: "gen_ops", label: "Gen ops" },
      { value: "growth", label: "Growth" },
      { value: "school_startup", label: "School startup" },
      { value: "teacher_training", label: "Teacher training" },
      { value: "project", label: "Project" },
    ],
  },
];
