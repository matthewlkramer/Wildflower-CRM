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
      { value: "tier_10k_50k", label: formatCapacity("tier_10k_50k") ?? "$10K–50K" },
      { value: "tier_50k_250k", label: formatCapacity("tier_50k_250k") ?? "$50K–250K" },
      { value: "tier_250k_1m", label: formatCapacity("tier_250k_1m") ?? "$250K–1M" },
      { value: "tier_1m_plus", label: formatCapacity("tier_1m_plus") ?? "$1M+" },
    ],
  },
  {
    kind: "boolean",
    key: "isPriority",
    label: "Priority",
    trueLabel: "Priority",
    falseLabel: "Not priority",
  },
  {
    kind: "boolean",
    key: "deceased",
    label: "Deceased",
    trueLabel: "Deceased",
    falseLabel: "Living",
    destructiveValue: true,
  },
];

export const FUNDERS_BULK_FIELDS: ReadonlyArray<BulkField> = [
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
      { value: "advocate", label: "Advocate" },
      { value: "supportive", label: "Supportive" },
      { value: "warm", label: "Warm" },
      { value: "neutral", label: "Neutral" },
      { value: "unsupportive", label: "Unsupportive" },
    ],
  },
  {
    kind: "boolean",
    key: "isPriority",
    label: "Priority",
    trueLabel: "Priority",
    falseLabel: "Not priority",
  },
  {
    kind: "enum",
    key: "fundingEntitySubtype",
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
    kind: "enum",
    key: "status",
    label: "Status",
    nullable: true,
    options: [
      { value: "open", label: "Open" },
      { value: "won", label: "Won" },
      { value: "lost", label: "Lost", destructive: true },
      { value: "dormant", label: "Dormant", destructive: true },
    ],
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
      { value: "conditional_commitment", label: "Conditional commitment" },
      { value: "probable_renewal", label: "Probable renewal" },
      { value: "verbal_commitment", label: "Verbal commitment" },
      { value: "written_commitment", label: "Written commitment" },
      { value: "cash_in", label: "Cash in" },
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
    kind: "string-array",
    key: "coveredFiscalYears",
    modeKey: "coveredFiscalYearsMode",
    label: "Covered fiscal years",
    source: "fiscalYears",
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
    ],
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
];
