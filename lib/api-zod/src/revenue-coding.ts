/**
 * Revenue-accounting / QuickBooks coding derivation.
 *
 * ENV-NEUTRAL: this module is imported by BOTH the API server (to store a
 * derived coding snapshot on each allocation write) and the browser (to show a
 * live read-only preview in the allocation editors). It must contain NO node /
 * DOM / URL globals and NO database imports — pure data + pure functions only.
 *
 * Source of truth: the CFO "Wildflower Revenue Extractor" specification. This
 * library captures the deterministic parts of that spec:
 *   - the closed Revenue Account (Object Code) list,
 *   - the closed Location list,
 *   - the payer-type × restriction → Object Code mapping,
 *   - the fiscal-sponsee ("SPO") always-restricted defaults (entity coding rules),
 *   - the Location derivation hints,
 *   - the Class rule (only BWF / Charter SPO locations).
 *
 * The CRM CAPTURES this coding data. It does NOT compute accrual / AR — that is
 * the accountant's job inside QBO. Anything the rules can't resolve cleanly is
 * surfaced as a coding FLAG for human review rather than silently guessed.
 */

// ── Restriction taxonomy ────────────────────────────────────────────────────
export const RESTRICTION_TYPES = [
  "unrestricted",
  "purpose",
  "time",
  "both",
  "unclear",
  "na",
] as const;
export type RestrictionType = (typeof RESTRICTION_TYPES)[number];

export const DEFERRED_REVENUE_VALUES = ["yes", "no", "na"] as const;
export type DeferredRevenue = (typeof DEFERRED_REVENUE_VALUES)[number];

// A restriction is "restricted" (→ 4100.x) when purpose / time / both.
// LEGACY: kept for the deprecated `restriction_type` columns still physically
// present on the allocation tables. The live coding derivation now reads the
// three restriction axes (see `anyDonorRestricted`).
export function isRestricted(rt: RestrictionType | null | undefined): boolean {
  return rt === "purpose" || rt === "time" || rt === "both";
}

// ── Three-axis restriction taxonomy ─────────────────────────────────────────
// Each allocation carries three independent restriction axes — regional,
// fund-use (usage), and time — each one of these values. A line is "restricted"
// for object-code purposes (→ 4100.x) when ANY axis is donor_restricted;
// wf_restricted (an internal Wildflower designation) and unrestricted both count
// as unrestricted for revenue-account coding.
export const RESTRICTION_AXIS_VALUES = [
  "donor_restricted",
  "wf_restricted",
  "unrestricted",
] as const;
export type RestrictionAxis = (typeof RESTRICTION_AXIS_VALUES)[number];

export function anyDonorRestricted(
  ...axes: Array<RestrictionAxis | string | null | undefined>
): boolean {
  return axes.some((a) => a === "donor_restricted");
}

// ── Payer type ──────────────────────────────────────────────────────────────
// The .x suffix of a contribution account is the payer type.
export const PAYER_TYPES = [
  "individual",
  "foundation",
  "corporation",
  "governmental",
] as const;
export type PayerType = (typeof PAYER_TYPES)[number];

export type DonorKind = "individual" | "household" | "organization";

/**
 * Map a CRM donor to a CFO payer type.
 *   - individual people + households  → individual
 *   - organizations                   → from their entity_type
 * `entityType` is the organizations.entity_type enum value (or null).
 */
export function derivePayerType(
  donorKind: DonorKind | null | undefined,
  entityType: string | null | undefined,
): { payerType: PayerType; assumed: boolean } {
  if (donorKind === "individual" || donorKind === "household") {
    return { payerType: "individual", assumed: false };
  }
  if (donorKind === "organization") {
    switch (entityType) {
      case "government":
      case "authorizer":
      case "elected_official":
      case "school_district":
      case "tribal":
        return { payerType: "governmental", assumed: false };
      case "corporation":
      case "education_forprofit":
      case "small_business_consulting":
      case "real_estate":
      case "law_firm":
      case "media":
      case "investor":
        return { payerType: "corporation", assumed: false };
      case "family_foundation":
      case "institutional_foundation":
      case "corporate_foundation":
      case "community_foundation":
      case "bank_foundation":
      case "family_office_trust":
      case "intermediary":
      case "nonprofit":
      case "capital_provider":
      case "philanthropic_advisor":
      case "cdfi":
      case "daf_platform":
      case "platform":
        return { payerType: "foundation", assumed: false };
      default:
        // Unmapped / null org entity type — default to foundation but flag it
        // so a human verifies the .x suffix.
        return { payerType: "foundation", assumed: true };
    }
  }
  // No donor resolvable → assume individual and flag.
  return { payerType: "individual", assumed: true };
}

// ── Closed Revenue Account (Object Code) list ───────────────────────────────
export interface RevenueAccount {
  code: string;
  name: string;
  // 'unrestricted' (4000.x) | 'restricted' (4100.x) | 'special'
  kind: "unrestricted" | "restricted" | "special";
  // Payer suffix for the .x contribution accounts; null for special accounts.
  payerType: PayerType | null;
  sortOrder: number;
}

export const REVENUE_ACCOUNTS: RevenueAccount[] = [
  { code: "4000.1", name: "Unrestricted Donations - Individual", kind: "unrestricted", payerType: "individual", sortOrder: 10 },
  { code: "4000.2", name: "Unrestricted Donations - Foundation", kind: "unrestricted", payerType: "foundation", sortOrder: 20 },
  { code: "4000.3", name: "Unrestricted Donations - Corporation", kind: "unrestricted", payerType: "corporation", sortOrder: 30 },
  { code: "4000.4", name: "Unrestricted Donations - Governmental", kind: "unrestricted", payerType: "governmental", sortOrder: 40 },
  { code: "4010", name: "Interest Earned", kind: "special", payerType: null, sortOrder: 50 },
  { code: "4020", name: "Services - Earned Income", kind: "special", payerType: null, sortOrder: 60 },
  { code: "4099", name: "Uncategorized Revenue", kind: "special", payerType: null, sortOrder: 70 },
  { code: "4100.1", name: "Restricted Donations - Individual", kind: "restricted", payerType: "individual", sortOrder: 80 },
  { code: "4100.2", name: "Restricted Donations - Foundation", kind: "restricted", payerType: "foundation", sortOrder: 90 },
  { code: "4100.3", name: "Restricted Donations - Corporation", kind: "restricted", payerType: "corporation", sortOrder: 100 },
  { code: "4100.4", name: "Restricted Donations - Governmental", kind: "restricted", payerType: "governmental", sortOrder: 110 },
  { code: "4102", name: "Guaranty Revenue", kind: "special", payerType: null, sortOrder: 120 },
  { code: "4300", name: "Intercompany Donation Allocation", kind: "special", payerType: null, sortOrder: 130 },
  { code: "4500", name: "Loan Fund Servicing", kind: "special", payerType: null, sortOrder: 140 },
];

export const REVENUE_ACCOUNT_CODES = REVENUE_ACCOUNTS.map((a) => a.code);

const PAYER_SUFFIX: Record<PayerType, string> = {
  individual: "1",
  foundation: "2",
  corporation: "3",
  governmental: "4",
};

function contributionAccount(restricted: boolean, payer: PayerType): string {
  return `${restricted ? "4100" : "4000"}.${PAYER_SUFFIX[payer]}`;
}

// ── Closed Location list ────────────────────────────────────────────────────
export const LOCATIONS = [
  "Development",
  "Foundation General", // default when unclear
  "Foundation Operations",
  "Hub - Colorado",
  "Hub - District of Columbia",
  "Hub - Mid-Atlantic",
  "Hub - Minnesota",
  "Hub - Puerto Rico",
  "Loans",
  "Radicle Hub",
  "School Support",
  "SPO_Seed Fund",
  "Spo- Black Wildflowers Fund",
  "Spo- Charter",
  "Spo- Tierra Indígena",
] as const;
export type Location = (typeof LOCATIONS)[number];

export const DEFAULT_LOCATION: Location = "Foundation General";

// Class is used only for the BWF / Charter SPO locations.
export const GENERAL_OPERATIONS_CLASS = "General Operations";

// State abbreviation → Hub location (only states that have their own Hub).
export const STATE_TO_HUB: Record<string, Location> = {
  CO: "Hub - Colorado",
  DC: "Hub - District of Columbia",
  MN: "Hub - Minnesota",
  PR: "Hub - Puerto Rico",
};

// ── Entity coding rules (fiscal-sponsee "SPO" defaults) ──────────────────────
/**
 * Per-entity coding defaults, keyed on the fund `entityId`. Fiscal sponsees are
 * ALWAYS purpose-restricted to the sponsee regardless of donor language, land
 * in their matching SPO location, and (BWF / Charter only) carry the General
 * Operations class. Loan-fund entities route to the Loans location.
 *
 * This is the admin-editable seed (mirrored into the `entity_coding_rules` DB
 * table + a fidelity test). `forceRestricted` upgrades the object code to the
 * 4100.x restricted family even when the donor wrote "unrestricted".
 */
export interface EntityCodingRule {
  entityId: string;
  // When true, treat the gift as purpose-restricted regardless of donor language.
  forceRestricted: boolean;
  // Location to assign (one of the closed Location list values), or null.
  location: Location | null;
  // Suggested class, or null (only BWF / Charter use General Operations).
  revenueClass: string | null;
  enabled: boolean;
  notes: string | null;
}

export const SEED_ENTITY_CODING_RULES: EntityCodingRule[] = [
  {
    entityId: "black_wildflowers_fund",
    forceRestricted: true,
    location: "Spo- Black Wildflowers Fund",
    revenueClass: GENERAL_OPERATIONS_CLASS,
    enabled: true,
    notes: "Fiscal sponsee — always purpose-restricted to BWF; class General Operations.",
  },
  {
    entityId: "tierra_indigena",
    forceRestricted: true,
    location: "Spo- Tierra Indígena",
    revenueClass: null,
    enabled: true,
    notes: "Fiscal sponsee — always purpose-restricted to Tierra Indígena; no class.",
  },
  {
    entityId: "sunlight_debt",
    forceRestricted: false,
    location: "Loans",
    revenueClass: null,
    enabled: true,
    notes: "Loan-fund entity — routes to Loans location.",
  },
  {
    entityId: "sunlight_grants",
    forceRestricted: false,
    location: "Loans",
    revenueClass: null,
    enabled: true,
    notes: "Loan-fund entity — routes to Loans location.",
  },
];

// ── Derivation ──────────────────────────────────────────────────────────────
export interface CodingInput {
  donorKind: DonorKind | null;
  // organizations.entity_type for an org donor (else null).
  orgEntityType: string | null;
  // Three-axis restriction taxonomy. A line is "restricted" (→ 4100.x) when ANY
  // axis is donor_restricted; wf_restricted / unrestricted both count as
  // unrestricted for revenue-account coding.
  regionalRestrictionType?: RestrictionAxis | string | null;
  otherRestrictionType?: RestrictionAxis | string | null;
  timeRestrictionType?: RestrictionAxis | string | null;
  // gifts_and_payments.type — 'loan_fund_investment' was the LEGACY loan signal.
  // Prefer `loanOrGrant` when present; this stays only as the fallback.
  giftType?: string | null;
  // Authoritative loan-vs-grant flag (A002 read cutover). When provided it
  // supersedes the giftType loan signal. 'loan' ⇒ principal movement, no
  // revenue account.
  loanOrGrant?: string | null;
  // The fund entity this allocation lands in (entities.id).
  entityId: string | null;
  // intended_usage + fundable_project for location hints.
  intendedUsage?: string | null;
  fundableProjectId?: string | null;
  // The fundable project's configured Revenue Location (fundable_projects
  // .location_code). Used for project-specific grants when no entity rule and no
  // regional hub apply. When a project is set but this is null, a
  // `project_location_missing` flag is surfaced.
  fundableProjectLocation?: string | null;
  // State abbreviations for the allocation's region(s) (for Hub mapping).
  regionStates?: (string | null | undefined)[];
  // ── Revenue-type / evidence signals (Task #607) ──
  // Present when a grant/award letter is on file (gift or linked pledge).
  hasGrantLetter?: boolean;
  // Present when the gift carries a reporting requirement / reporting deadline.
  hasReportingRequirement?: boolean;
  // The donor's restriction language, verbatim (gift_allocations.purpose_verbatim).
  purposeVerbatim?: string | null;
}

export interface CodingResult {
  objectCode: string | null;
  location: Location | null;
  revenueClass: string | null;
  // Derived revenue type: 'grant' when a grant letter / reporting requirement /
  // any donor restriction is present, else 'donation'.
  revenueType: RevenueType;
  // Human-facing restriction label derived from the axes.
  restrictionType: RestrictionLabel;
  // Human-readable restriction-evidence hint ("" for unrestricted lines).
  restrictionEvidence: string;
  flags: string[];
}

// ── Revenue type + restriction label (Task #607) ────────────────────────────
export type RevenueType = "grant" | "donation";
export type RestrictionLabel = "Unrestricted" | "Purpose" | "Time" | "Both";

/**
 * Suggested Class. Entity rules win; otherwise Charter work — which derives to
 * the "Spo- Charter" location via the `charter_growth` fundable project and has
 * no dedicated entity rule — is coded to General Operations. Everything else is
 * left unset.
 */
export function deriveRevenueClass(
  rule: EntityCodingRule | undefined,
  location: Location | null,
): string | null {
  if (rule?.revenueClass) return rule.revenueClass;
  if (location === "Spo- Charter") return GENERAL_OPERATIONS_CLASS;
  return null;
}

/**
 * Derive Object Code, Location and Suggested Class for a gift/pledge allocation.
 * `entityRules` is the live (DB) rule set; pass SEED_ENTITY_CODING_RULES when no
 * DB rules are loaded. Anything ambiguous is surfaced as a `flags` entry so the
 * accountant reviews it rather than trusting a silent guess.
 */
export function deriveRevenueCoding(
  input: CodingInput,
  entityRules: EntityCodingRule[] = SEED_ENTITY_CODING_RULES,
): CodingResult {
  const flags: string[] = [];

  // Loan-fund investments are principal movements, not revenue — no account.
  // Read the authoritative loan_or_grant flag when present (A002 read cutover);
  // fall back to the legacy giftType signal for callers not yet passing it.
  const isLoan =
    input.loanOrGrant != null
      ? input.loanOrGrant === "loan"
      : input.giftType === "loan_fund_investment";
  // Restriction status: an entity rule can force restricted; otherwise the line
  // is restricted when ANY restriction axis is donor_restricted. wf_restricted
  // and unrestricted both code as unrestricted (4000.x). Axes default
  // unrestricted, so there is no "unclear" path to flag.
  const rule = entityRules.find(
    (r) => r.enabled && r.entityId === input.entityId,
  );
  const restricted =
    rule?.forceRestricted === true ||
    anyDonorRestricted(
      input.regionalRestrictionType,
      input.otherRestrictionType,
      input.timeRestrictionType,
    );

  const restrictionType = deriveRestrictionLabel(input, rule);
  const revenueType = deriveRevenueType(input, restricted);
  const restrictionEvidence = deriveRestrictionEvidence(
    input,
    restrictionType,
  );

  if (isLoan) {
    return {
      objectCode: null,
      location: deriveLocation(input, entityRules, flags),
      revenueClass: null,
      revenueType,
      restrictionType,
      restrictionEvidence,
      flags: [...flags, "loan_no_revenue_account"],
    };
  }

  // Location + Class are independent of the restriction outcome, so derive them
  // once here and reuse on every return path.
  const location = deriveLocation(input, entityRules, flags);
  const revenueClass = deriveRevenueClass(rule, location);

  const { payerType, assumed } = derivePayerType(
    input.donorKind,
    input.orgEntityType,
  );
  if (assumed) flags.push("payer_type_assumed");

  const objectCode = contributionAccount(restricted, payerType);

  return {
    objectCode,
    location,
    revenueClass,
    revenueType,
    restrictionType,
    restrictionEvidence,
    flags,
  };
}

/**
 * Derive the Location, in priority order:
 *   1. entity coding rule location (SPO / Loans),
 *   2. charter fundable-project → Spo- Charter,
 *   3. region state → Hub,
 *   4. fundable-project configured location code,
 *   5. default Foundation General.
 * A `project_location_missing` flag is surfaced when a project is set but its
 * location code is unresolved (nothing above it matched either).
 */
export function deriveLocation(
  input: CodingInput,
  entityRules: EntityCodingRule[],
  flags: string[],
): Location {
  const rule = entityRules.find(
    (r) => r.enabled && r.entityId === input.entityId,
  );
  if (rule?.location) return rule.location;

  // Charter work → Spo- Charter (no dedicated entity exists; keyed off the
  // charter_growth fundable project).
  if (input.fundableProjectId === "charter_growth") {
    return "Spo- Charter";
  }

  // Region → Hub (only states that have their own Hub).
  for (const st of input.regionStates ?? []) {
    if (st && STATE_TO_HUB[st]) return STATE_TO_HUB[st];
  }

  // Project-specific location code, when the project configures one.
  const projLoc = input.fundableProjectLocation;
  if (projLoc && (LOCATIONS as readonly string[]).includes(projLoc)) {
    return projLoc as Location;
  }

  // A project was set but resolved to no location — surface for review.
  if (input.fundableProjectId) flags.push("project_location_missing");
  return DEFAULT_LOCATION;
}

/**
 * Restriction label from the three axes (+ an entity forceRestricted rule):
 *   - regional or usage donor_restricted ⇒ Purpose,
 *   - time donor_restricted ⇒ Time,
 *   - both ⇒ Both, neither ⇒ Unrestricted.
 * A forceRestricted entity rule (fiscal sponsee) counts as a purpose restriction.
 */
export function deriveRestrictionLabel(
  input: CodingInput,
  rule: EntityCodingRule | undefined,
): RestrictionLabel {
  const purpose =
    rule?.forceRestricted === true ||
    anyDonorRestricted(
      input.regionalRestrictionType,
      input.otherRestrictionType,
    );
  const time = anyDonorRestricted(input.timeRestrictionType);
  if (purpose && time) return "Both";
  if (purpose) return "Purpose";
  if (time) return "Time";
  return "Unrestricted";
}

/**
 * Revenue type: a gift is a `grant` when a grant/award letter or a reporting
 * requirement is on file, or when the money is donor-restricted; otherwise it is
 * an unrestricted `donation`.
 */
export function deriveRevenueType(
  input: CodingInput,
  restricted: boolean,
): RevenueType {
  if (input.hasGrantLetter || input.hasReportingRequirement || restricted) {
    return "grant";
  }
  return "donation";
}

/**
 * Human-readable restriction-evidence hint. Empty for unrestricted lines. For
 * restricted lines: the donor's verbatim purpose language when present, plus a
 * "Grant letter on file" note when applicable.
 */
export function deriveRestrictionEvidence(
  input: CodingInput,
  restrictionType: RestrictionLabel,
): string {
  if (restrictionType === "Unrestricted") return "";
  const parts: string[] = [];
  const verbatim = input.purposeVerbatim?.trim();
  if (verbatim) parts.push(verbatim);
  if (input.hasGrantLetter) parts.push("Grant letter on file");
  if (input.hasReportingRequirement) parts.push("Reporting requirement");
  return parts.join("; ");
}

/**
 * Deferred revenue is a FISCAL-YEAR comparison, not a raw-date one: revenue is
 * deferred when an allocation is booked to a fiscal year LATER than the fiscal
 * year the money was received in (received now, earned in a future FY).
 *
 * Both arguments are the ISO (YYYY-MM-DD) *start dates* of the fiscal years in
 * question — the transaction date's fiscal year, and the allocation's booked
 * fiscal year. Fiscal years are contiguous and identified by their start date,
 * so comparing FY start dates orders the years. Returns "yes" when the
 * allocation FY starts after the transaction FY, "no" when it does not, and
 * "na" when either fiscal year is unknown.
 */
export function deriveDeferredRevenue(
  transactionFyStart: string | null | undefined,
  allocationFyStart: string | null | undefined,
): DeferredRevenue {
  if (!transactionFyStart || !allocationFyStart) return "na";
  return allocationFyStart > transactionFyStart ? "yes" : "no";
}

/**
 * Describe the payment schedule for the Revenue Extractor. A standalone gift is
 * "Single payment"; a pledge installment is "Pledge payment[ N of M]".
 */
export function describePaymentSchedule(input: {
  isPledgePayment?: boolean;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  remainingExpected?: number | null;
  nextExpectedDate?: string | null;
}): string {
  if (!input.isPledgePayment) return "Single payment";
  const {
    installmentNumber,
    totalInstallments,
    remainingExpected,
    nextExpectedDate,
  } = input;
  let base = "Pledge payment";
  if (installmentNumber && totalInstallments) {
    base = `Pledge payment ${installmentNumber} of ${totalInstallments}`;
  } else if (installmentNumber) {
    base = `Pledge payment ${installmentNumber}`;
  }
  // "what else is still expected" — help finance match against prior entries.
  const notes: string[] = [];
  if (nextExpectedDate) notes.push(`next expected ${nextExpectedDate}`);
  if (remainingExpected != null && remainingExpected > 0) {
    notes.push(
      `${remainingExpected} more expected`,
    );
  }
  return notes.length > 0 ? `${base} (${notes.join(", ")})` : base;
}

/** Effective value = manual override when set, else the derived snapshot. */
export function effectiveCoding<T>(
  override: T | null | undefined,
  derived: T | null | undefined,
): T | null {
  return (override ?? derived ?? null) as T | null;
}
