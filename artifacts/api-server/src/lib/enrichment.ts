import { db } from "@workspace/db";
import {
  addresses,
  enrichmentSuggestions,
  people,
  peopleEntityRoles,
  regions,
} from "@workspace/db/schema";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { newId } from "./helpers";

type EntityType = "person" | "organization";

export type AddressSignal = {
  cityRegionId: string | null;
  stateRegionId: string | null;
  stateCode: string | null;
  cityName: string | null;
  postalCode: string | null;
  updatedAt: Date;
  priority: number;
  sourceLabel: string;
};

export type RegionSignal = {
  id: string;
  displayPath: string;
  stateAbbreviation: string | null;
  type: string | null;
};

export type RegionSuggestionEvidence = {
  regionId: string;
  label: string;
  sourceLabel: string;
  sourceDetail: string | null;
};

export function isExternalEnrichmentEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ENRICHMENT_EXTERNAL_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Deliberate integration seam for future wealth-screening/registry providers.
 * No provider is configured today, so enabling the flag still performs no
 * lookup; adding one requires its own reviewed privacy and provenance design.
 */
export async function runExternalEnrichmentStubs(
  _entityType: EntityType,
  _entityId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isExternalEnrichmentEnabled(env)) return;
}

function addressDetail(signal: AddressSignal): string | null {
  const locality = [signal.cityName, signal.stateCode]
    .filter(Boolean)
    .join(", ");
  return [locality, signal.postalCode].filter(Boolean).join(" ") || null;
}

/**
 * Prefer the most direct and most recently updated address, and prefer its
 * most precise valid region link. State-code fallback is intentionally used
 * only when an address has no usable linked city/state region.
 */
export function selectAddressRegionSuggestion(
  addressSignals: AddressSignal[],
  regionSignals: RegionSignal[],
): RegionSuggestionEvidence | null {
  const regionById = new Map(
    regionSignals.map((region) => [region.id, region]),
  );
  const stateByAbbreviation = new Map(
    regionSignals
      .filter(
        (region) =>
          region.type === "state" && Boolean(region.stateAbbreviation?.trim()),
      )
      .map((region) => [
        region.stateAbbreviation!.trim().toUpperCase(),
        region,
      ]),
  );

  const sorted = [...addressSignals].sort(
    (a, b) =>
      a.priority - b.priority || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  for (const signal of sorted) {
    const region =
      (signal.cityRegionId ? regionById.get(signal.cityRegionId) : undefined) ??
      (signal.stateRegionId
        ? regionById.get(signal.stateRegionId)
        : undefined) ??
      (signal.stateCode
        ? stateByAbbreviation.get(signal.stateCode.trim().toUpperCase())
        : undefined);
    if (!region) continue;
    return {
      regionId: region.id,
      label: region.displayPath,
      sourceLabel: signal.sourceLabel,
      sourceDetail: addressDetail(signal),
    };
  }
  return null;
}

async function loadRegionEvidence(
  signals: AddressSignal[],
): Promise<RegionSignal[]> {
  const linkedIds = Array.from(
    new Set(
      signals.flatMap((signal) =>
        [signal.cityRegionId, signal.stateRegionId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ),
  );
  const where = linkedIds.length
    ? or(inArray(regions.id, linkedIds), eq(regions.type, "state"))
    : eq(regions.type, "state");
  return db
    .select({
      id: regions.id,
      displayPath: regions.displayPath,
      stateAbbreviation: regions.stateAbbreviation,
      type: regions.type,
    })
    .from(regions)
    .where(and(isNull(regions.archivedAt), where));
}

function asSignal(
  row: typeof addresses.$inferSelect,
  priority: number,
  sourceLabel: string,
): AddressSignal {
  return {
    cityRegionId: row.cityRegionId,
    stateRegionId: row.stateRegionId,
    stateCode: row.stateCode,
    cityName: row.cityName,
    postalCode: row.postalCode,
    updatedAt: row.updatedAt,
    priority,
    sourceLabel,
  };
}

export async function derivePersonHomeRegion(
  personId: string,
  primaryHouseholdId: string | null,
): Promise<RegionSuggestionEvidence | null> {
  const [direct, household, affiliations] = await Promise.all([
    db
      .select()
      .from(addresses)
      .where(eq(addresses.personId, personId))
      .orderBy(desc(addresses.updatedAt)),
    primaryHouseholdId
      ? db
          .select()
          .from(addresses)
          .where(eq(addresses.householdId, primaryHouseholdId))
          .orderBy(desc(addresses.updatedAt))
      : Promise.resolve([]),
    db
      .select({ address: addresses })
      .from(peopleEntityRoles)
      .innerJoin(
        addresses,
        eq(addresses.organizationId, peopleEntityRoles.organizationId),
      )
      .where(
        and(
          eq(peopleEntityRoles.personId, personId),
          eq(peopleEntityRoles.entityType, "organization"),
          eq(peopleEntityRoles.current, "current"),
        ),
      )
      .orderBy(desc(addresses.updatedAt)),
  ]);
  const signals = [
    ...direct.map((address) => asSignal(address, 1, "Direct address")),
    ...household.map((address) =>
      asSignal(address, 2, "Primary household address"),
    ),
    ...affiliations.map(({ address }) =>
      asSignal(address, 3, "Current organization address"),
    ),
  ];
  return selectAddressRegionSuggestion(
    signals,
    await loadRegionEvidence(signals),
  );
}

export async function deriveOrganizationRegion(
  organizationId: string,
): Promise<RegionSuggestionEvidence | null> {
  const direct = await db
    .select()
    .from(addresses)
    .where(eq(addresses.organizationId, organizationId))
    .orderBy(desc(addresses.updatedAt));
  const signals = direct.map((address) =>
    asSignal(address, 1, "Organization address"),
  );
  return selectAddressRegionSuggestion(
    signals,
    await loadRegionEvidence(signals),
  );
}

export async function saveRegionSuggestion(
  entityType: EntityType,
  entityId: string,
  fieldName: "currentHomeRegionId" | "regionIds",
  evidence: RegionSuggestionEvidence,
): Promise<void> {
  const history = await db
    .select({
      status: enrichmentSuggestions.status,
      suggestedValue: enrichmentSuggestions.suggestedValue,
    })
    .from(enrichmentSuggestions)
    .where(
      and(
        eq(enrichmentSuggestions.entityType, entityType),
        eq(enrichmentSuggestions.entityId, entityId),
        eq(enrichmentSuggestions.fieldName, fieldName),
        eq(enrichmentSuggestions.status, "pending"),
      ),
    )
    .orderBy(desc(enrichmentSuggestions.createdAt));
  if (history.length > 0) return;

  await db
    .insert(enrichmentSuggestions)
    .values({
      id: newId(),
      entityType,
      entityId,
      fieldName,
      suggestedValue: {
        regionId: evidence.regionId,
        label: evidence.label,
      },
      sourceLabel: evidence.sourceLabel,
      sourceDetail: evidence.sourceDetail,
    })
    .onConflictDoNothing();
}

export async function runPersonRegionEnrichment(personId: string) {
  const person = await db
    .select({
      id: people.id,
      currentHomeRegionId: people.currentHomeRegionId,
      primaryHouseholdId: people.primaryHouseholdId,
    })
    .from(people)
    .where(eq(people.id, personId))
    .then((rows) => rows[0]);
  if (!person) return false;
  if (!person.currentHomeRegionId) {
    const evidence = await derivePersonHomeRegion(
      person.id,
      person.primaryHouseholdId,
    );
    if (evidence) {
      await saveRegionSuggestion(
        "person",
        person.id,
        "currentHomeRegionId",
        evidence,
      );
    }
  }
  return true;
}
