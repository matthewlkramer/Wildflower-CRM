// Per-entity field catalogs for the CSV export endpoints.
//
// Keys deliberately match the frontend column-registry keys (see
// artifacts/wildflower-crm/src/lib/columns.tsx consumers) so the client can
// send its visible-column keys directly as `?fields=`. Values read the SAME
// masked list rows the JSON list endpoints return — masking/permissions are
// applied before these accessors ever run, so an export can never reveal
// more than the on-screen list.

import { db } from "@workspace/db";
import {
  users,
  regions,
  entities,
  fundableProjects,
  fundraisingCampaigns,
} from "@workspace/db/schema";
import { labelizeEnum } from "./csvExport";

type Row = Record<string, unknown>;

// How many rows each export batch pulls. Exports loop batches until
// exhaustion so the CSV always covers every authorized match.
export const EXPORT_BATCH_SIZE = 1000;

export type ExportContext = {
  userNames: Map<string, string>;
  regionNames: Map<string, string>;
  entityNames: Map<string, string>;
  fundableProjectNames: Map<string, string>;
  campaignNames: Map<string, string>;
};

export type ExportField = {
  key: string;
  label: string;
  value: (row: Row, ctx: ExportContext) => unknown;
};

/** Load the id→name lookup maps the accessors need (one query per table). */
export async function loadExportContext(): Promise<ExportContext> {
  const [userRows, regionRows, entityRows, projectRows, campaignRows] =
    await Promise.all([
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
        })
        .from(users),
      db.select({ id: regions.id, name: regions.name }).from(regions),
      db.select({ id: entities.id, name: entities.name }).from(entities),
      db
        .select({ id: fundableProjects.id, name: fundableProjects.name })
        .from(fundableProjects),
      db
        .select({
          slug: fundraisingCampaigns.slug,
          name: fundraisingCampaigns.name,
        })
        .from(fundraisingCampaigns),
    ]);
  return {
    userNames: new Map(
      userRows.map((u) => [
        u.id,
        u.displayName ||
          [u.firstName, u.lastName].filter(Boolean).join(" ") ||
          u.email,
      ]),
    ),
    regionNames: new Map(regionRows.map((r) => [r.id, r.name])),
    entityNames: new Map(entityRows.map((e) => [e.id, e.name])),
    fundableProjectNames: new Map(projectRows.map((p) => [p.id, p.name])),
    campaignNames: new Map(campaignRows.map((c) => [c.slug, c.name])),
  };
}

const str = (v: unknown) => (v == null ? "" : String(v));
const mapped = (m: Map<string, string>, id: unknown) =>
  id == null || id === "" ? "" : (m.get(String(id)) ?? String(id));
const mappedList = (m: Map<string, string>, ids: unknown) =>
  Array.isArray(ids) ? ids.map((id) => mapped(m, id)) : "";
const upperList = (v: unknown) =>
  Array.isArray(v) ? v.map((x) => str(x).toUpperCase()) : "";
const enumList = (v: unknown) =>
  Array.isArray(v) ? v.map((x) => labelizeEnum(x)) : "";

function personDisplayName(row: Row): string {
  const full = str(row.fullName).trim();
  if (full) return full;
  return [str(row.firstName).trim(), str(row.lastName).trim()]
    .filter(Boolean)
    .join(" ");
}

// Donor display for opps/gifts — mirrors DonorCell precedence
// (organization, then household, then individual giver).
function donorName(row: Row): string {
  return (
    str(row.organizationName) ||
    str(row.householdName) ||
    str(row.individualGiverPersonName)
  );
}

export const PEOPLE_EXPORT_FIELDS: ExportField[] = [
  { key: "name", label: "Name", value: (r) => personDisplayName(r) },
  { key: "priorityTier", label: "Priority", value: (r) => labelizeEnum(r.priority) },
  { key: "status", label: "Deceased", value: (r) => (r.deceased ? "Yes" : "") },
  {
    key: "region",
    label: "Home region",
    value: (r, ctx) => mapped(ctx.regionNames, r.currentHomeRegionId),
  },
  { key: "capacity", label: "Capacity", value: (r) => labelizeEnum(r.capacityRating) },
  { key: "lastContacted", label: "Last contacted", value: (r) => r.lastContacted },
  { key: "lifetimeGiving", label: "Lifetime giving", value: (r) => r.lifetimeGiving },
  { key: "lastGift", label: "Last gift", value: (r) => r.mostRecentGiftDate },
  { key: "openAsks", label: "Open asks", value: (r) => r.openOpportunityCount ?? 0 },
  {
    key: "activeFunders",
    label: "Active funders / orgs",
    value: (r) => (Array.isArray(r.activeOrganizationNames) ? r.activeOrganizationNames : ""),
  },
  {
    key: "pastFunders",
    label: "Past funders / orgs",
    value: (r) => (Array.isArray(r.pastOrganizationNames) ? r.pastOrganizationNames : ""),
  },
  { key: "owner", label: "Owner", value: (r, ctx) => mapped(ctx.userNames, r.ownerUserId) },
  {
    key: "newsletter",
    label: "Newsletter",
    // Mirrors the list page's derived status: unsubscribed wins over the flag.
    value: (r) =>
      r.unsubscribedToNewsletter
        ? "Unsubscribed"
        : r.newsletter
          ? "Subscribed"
          : "Not subscribed",
  },
  { key: "connectionStatus", label: "Connection", value: (r) => labelizeEnum(r.connectionStatus) },
  { key: "enthusiasm", label: "Enthusiasm", value: (r) => labelizeEnum(r.enthusiasm) },
  { key: "interestsAges", label: "Ages", value: (r) => r.interestsAges },
  { key: "interestsThematic", label: "Themes", value: (r) => r.interestsThematic },
  { key: "interestsGovModels", label: "Governance", value: (r) => r.interestsGovModels },
  {
    key: "regionIds",
    label: "Regions",
    value: (r, ctx) => mappedList(ctx.regionNames, r.regionIds),
  },
];

export const ORGANIZATION_EXPORT_FIELDS: ExportField[] = [
  { key: "name", label: "Name", value: (r) => r.name },
  { key: "priorityTier", label: "Priority", value: (r) => labelizeEnum(r.priority) },
  { key: "entityType", label: "Type", value: (r) => labelizeEnum(r.entityType) },
  { key: "issuesGrants", label: "Grant-making", value: (r) => r.issuesGrants },
  { key: "makesPris", label: "Makes PRIs", value: (r) => r.makesPris },
  { key: "active", label: "Active", value: (r) => labelizeEnum(r.activeStatus) },
  { key: "connection", label: "Connection", value: (r) => labelizeEnum(r.connectionStatus) },
  { key: "enthusiasm", label: "Enthusiasm", value: (r) => labelizeEnum(r.enthusiasm) },
  {
    key: "strategicAlignment",
    label: "Strategic alignment",
    value: (r) => labelizeEnum(r.strategicAlignment),
  },
  { key: "capacity", label: "Capacity", value: (r) => labelizeEnum(r.capacityRating) },
  { key: "primaryContact", label: "Primary contact", value: (r) => r.primaryContactPersonName },
  { key: "lifetimeGiving", label: "Lifetime giving", value: (r) => r.lifetimeGiving },
  { key: "openAsks", label: "Open asks", value: (r) => r.openOpportunityCount ?? 0 },
  { key: "owner", label: "Owner", value: (r, ctx) => mapped(ctx.userNames, r.ownerUserId) },
  { key: "lastContacted", label: "Last contacted", value: (r) => r.lastContacted },
  { key: "interestsAges", label: "Ages", value: (r) => r.interestsAges },
  { key: "interestsThematic", label: "Themes", value: (r) => r.interestsThematic },
  { key: "interestsGovModels", label: "Governance", value: (r) => r.interestsGovModels },
  {
    key: "regionIds",
    label: "Regions",
    value: (r, ctx) => mappedList(ctx.regionNames, r.regionIds),
  },
];

export const OPPORTUNITY_EXPORT_FIELDS: ExportField[] = [
  { key: "name", label: "Name", value: (r) => r.name },
  { key: "donor", label: "Donor", value: (r) => donorName(r) },
  { key: "stage", label: "Stage", value: (r) => labelizeEnum(r.stage) },
  { key: "status", label: "Status", value: (r) => labelizeEnum(r.status) },
  { key: "ask", label: "Ask", value: (r) => r.askAmount },
  { key: "awarded", label: "Awarded", value: (r) => r.awardedAmount },
  { key: "paid", label: "Paid", value: (r) => r.paidAmount },
  {
    key: "entities",
    label: "Entities",
    value: (r, ctx) => mappedList(ctx.entityNames, r.entityIds),
  },
  {
    key: "fundableProjects",
    label: "Fundable projects",
    value: (r, ctx) => mappedList(ctx.fundableProjectNames, r.fundableProjectIds),
  },
  { key: "coveredFys", label: "Covered FYs", value: (r) => upperList(r.coveredFiscalYears) },
  { key: "projectedClose", label: "Projected close", value: (r) => r.projectedCloseDate },
  { key: "owner", label: "Owner", value: (r, ctx) => mapped(ctx.userNames, r.ownerUserId) },
  { key: "type", label: "Type", value: (r) => labelizeEnum(r.type) },
  { key: "applicationDeadline", label: "App deadline", value: (r) => r.applicationDeadline },
  {
    key: "winProbability",
    label: "Win probability",
    value: (r) =>
      r.winProbability == null ? "" : `${Math.round(Number(r.winProbability) * 100)}%`,
  },
];

export const GIFT_EXPORT_FIELDS: ExportField[] = [
  { key: "name", label: "Name", value: (r) => r.name },
  { key: "donor", label: "Donor", value: (r) => donorName(r) },
  { key: "dateReceived", label: "Date received", value: (r) => r.dateReceived },
  { key: "type", label: "Type", value: (r) => labelizeEnum(r.type) },
  { key: "amount", label: "Amount", value: (r) => r.amount },
  {
    key: "entities",
    label: "Entities",
    value: (r, ctx) => mappedList(ctx.entityNames, r.entityIds),
  },
  { key: "usages", label: "Usages", value: (r) => r.displayUsages },
  { key: "grantYears", label: "Grant years", value: (r) => upperList(r.grantYears) },
  {
    key: "fundableProjects",
    label: "Fundable projects",
    value: (r, ctx) => mappedList(ctx.fundableProjectNames, r.fundableProjectIds),
  },
  {
    key: "regions",
    label: "Regions",
    value: (r, ctx) => mappedList(ctx.regionNames, r.regionIds),
  },
  { key: "owner", label: "Owner", value: (r, ctx) => mapped(ctx.userNames, r.ownerUserId) },
  { key: "paymentMethod", label: "Payment method", value: (r) => labelizeEnum(r.paymentMethod) },
  { key: "thankYouSentAt", label: "Thank-you sent", value: (r) => r.thankYouSentAt },
  { key: "restrictionLabel", label: "Restriction", value: (r) => r.restrictionLabel },
  { key: "purposeVerbatims", label: "Purpose verbatim", value: (r) => r.purposeVerbatims },
  {
    key: "regionalRestrictionTypes",
    label: "Regional restriction",
    value: (r) => enumList(r.regionalRestrictionTypes),
  },
  {
    key: "otherRestrictionTypes",
    label: "Other restriction",
    value: (r) => enumList(r.otherRestrictionTypes),
  },
  {
    key: "timeRestrictionTypes",
    label: "Time restriction",
    value: (r) => enumList(r.timeRestrictionTypes),
  },
  {
    key: "campaign",
    label: "Campaign",
    value: (r, ctx) => mapped(ctx.campaignNames, r.campaignSlug),
  },
];

// Frontend column keys that map onto a differently-keyed export field
// (the priority-star column shares data with the priority-tier column).
const FIELD_KEY_ALIASES: Record<string, string> = {
  priority: "priorityTier",
};

/**
 * Resolve the requested `fields` keys against a catalog. Unknown keys (e.g.
 * the `actions` column) are silently dropped; no requested/empty list means
 * "all permitted fields". Order follows the catalog (stable, predictable).
 */
export function selectExportFields(
  catalog: ExportField[],
  requested: string[] | undefined,
): ExportField[] {
  if (!requested || requested.length === 0) return catalog;
  const wanted = new Set(
    requested.map((k) => FIELD_KEY_ALIASES[k] ?? k),
  );
  const picked = catalog.filter((f) => wanted.has(f.key));
  return picked.length > 0 ? picked : catalog;
}

/** Parse the `?fields=` comma-separated query param. */
export function parseFieldsParam(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
