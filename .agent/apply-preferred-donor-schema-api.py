from pathlib import Path
import json


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


write(
    "lib/db/src/schema/donorRoutingPreferences.ts",
    r'''
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { people } from "./people";
import { households } from "./households";
import { organizations } from "./organizations";
import { users } from "./users";

export type DonorRecordKind = "individual" | "household" | "organization";
export type StoredDonorRoutingMode = "target" | "ask";

/**
 * Explicit exceptions to the implicit donor-routing default.
 *
 * No row means "use this record". A row either points to another donor record
 * or says to ask each time. Keeping self-routing implicit avoids millions of
 * redundant rows while still giving every donor record an effective pathway.
 */
export const donorRoutingPreferences = pgTable(
  "donor_routing_preferences",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").$type<DonorRecordKind>().notNull(),
    sourcePersonId: text("source_person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    sourceHouseholdId: text("source_household_id").references(
      () => households.id,
      { onDelete: "cascade" },
    ),
    sourceOrganizationId: text("source_organization_id").references(
      () => organizations.id,
      { onDelete: "cascade" },
    ),
    mode: text("mode").$type<StoredDonorRoutingMode>().notNull(),
    targetKind: text("target_kind").$type<DonorRecordKind>(),
    targetPersonId: text("target_person_id").references(() => people.id, {
      onDelete: "restrict",
    }),
    targetHouseholdId: text("target_household_id").references(
      () => households.id,
      { onDelete: "restrict" },
    ),
    targetOrganizationId: text("target_organization_id").references(
      () => organizations.id,
      { onDelete: "restrict" },
    ),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "donor_routing_source_shape_ck",
      sql`num_nonnulls(${t.sourcePersonId}, ${t.sourceHouseholdId}, ${t.sourceOrganizationId}) = 1
        AND (
          (${t.sourceKind} = 'individual' AND ${t.sourcePersonId} IS NOT NULL)
          OR (${t.sourceKind} = 'household' AND ${t.sourceHouseholdId} IS NOT NULL)
          OR (${t.sourceKind} = 'organization' AND ${t.sourceOrganizationId} IS NOT NULL)
        )`,
    ),
    check(
      "donor_routing_target_shape_ck",
      sql`(
          ${t.mode} = 'ask'
          AND ${t.targetKind} IS NULL
          AND num_nonnulls(${t.targetPersonId}, ${t.targetHouseholdId}, ${t.targetOrganizationId}) = 0
        ) OR (
          ${t.mode} = 'target'
          AND ${t.targetKind} IS NOT NULL
          AND num_nonnulls(${t.targetPersonId}, ${t.targetHouseholdId}, ${t.targetOrganizationId}) = 1
          AND (
            (${t.targetKind} = 'individual' AND ${t.targetPersonId} IS NOT NULL)
            OR (${t.targetKind} = 'household' AND ${t.targetHouseholdId} IS NOT NULL)
            OR (${t.targetKind} = 'organization' AND ${t.targetOrganizationId} IS NOT NULL)
          )
        )`,
    ),
    uniqueIndex("donor_routing_source_person_uq")
      .on(t.sourcePersonId)
      .where(sql`${t.sourcePersonId} IS NOT NULL`),
    uniqueIndex("donor_routing_source_household_uq")
      .on(t.sourceHouseholdId)
      .where(sql`${t.sourceHouseholdId} IS NOT NULL`),
    uniqueIndex("donor_routing_source_org_uq")
      .on(t.sourceOrganizationId)
      .where(sql`${t.sourceOrganizationId} IS NOT NULL`),
    index("donor_routing_target_person_idx").on(t.targetPersonId),
    index("donor_routing_target_household_idx").on(t.targetHouseholdId),
    index("donor_routing_target_org_idx").on(t.targetOrganizationId),
  ],
);

export type DonorRoutingPreference =
  typeof donorRoutingPreferences.$inferSelect;
export type NewDonorRoutingPreference =
  typeof donorRoutingPreferences.$inferInsert;
''',
)

replace_once(
    "lib/db/src/schema/index.ts",
    'export * from "./donorPaymentIntermediaries";\n',
    'export * from "./donorPaymentIntermediaries";\nexport * from "./donorRoutingPreferences";\n',
    "schema export",
)

replace_once(
    "lib/db/src/schema/people.ts",
    'import { regions } from "./regions";\n',
    'import { regions } from "./regions";\nimport { households } from "./households";\n',
    "people household import",
)
replace_once(
    "lib/db/src/schema/people.ts",
    '''  currentHomeRegionId: text("current_home_region_id").references(
    () => regions.id,
    { onDelete: "set null" },
  ),
''',
    '''  currentHomeRegionId: text("current_home_region_id").references(
    () => regions.id,
    { onDelete: "set null" },
  ),
  // One current household authority. The legacy household role rows remain
  // temporarily for UI/history compatibility, but new business logic reads this
  // direct pointer rather than inferring one household from a many-to-many table.
  primaryHouseholdId: text("primary_household_id").references(
    () => households.id,
    { onDelete: "set null" },
  ),
''',
    "people primary household column",
)
replace_once(
    "lib/db/src/schema/people.ts",
    '  index("people_current_home_region_id_idx").on(t.currentHomeRegionId),\n',
    '  index("people_current_home_region_id_idx").on(t.currentHomeRegionId),\n  index("people_primary_household_id_idx").on(t.primaryHouseholdId),\n',
    "people primary household index",
)

replace_once(
    "lib/db/src/schema/donorPaymentIntermediaries.ts",
    '''  check,
  index,
''',
    '''  boolean,
  check,
  index,
''',
    "intermediary boolean import",
)
replace_once(
    "lib/db/src/schema/donorPaymentIntermediaries.ts",
    '    notes: text("notes"),\n',
    '    notes: text("notes"),\n    isDefault: boolean("is_default").notNull().default(false),\n',
    "intermediary default column",
)
replace_once(
    "lib/db/src/schema/donorPaymentIntermediaries.ts",
    '''    uniqueIndex("dpi_unique_household_pi")
      .on(t.householdId, t.paymentIntermediaryId)
      .where(sql`${t.householdId} IS NOT NULL`),
''',
    '''    uniqueIndex("dpi_unique_household_pi")
      .on(t.householdId, t.paymentIntermediaryId)
      .where(sql`${t.householdId} IS NOT NULL`),
    uniqueIndex("dpi_default_org_uq")
      .on(t.organizationId)
      .where(sql`${t.organizationId} IS NOT NULL AND ${t.isDefault} = true`),
    uniqueIndex("dpi_default_person_uq")
      .on(t.individualGiverPersonId)
      .where(
        sql`${t.individualGiverPersonId} IS NOT NULL AND ${t.isDefault} = true`,
      ),
    uniqueIndex("dpi_default_household_uq")
      .on(t.householdId)
      .where(sql`${t.householdId} IS NOT NULL AND ${t.isDefault} = true`),
''',
    "intermediary default indexes",
)

write(
    "lib/db/migrations/0221_preferred_donor_pathways.sql",
    r'''
-- Preferred donor pathways and one current household authority.
-- Additive and non-destructive: legacy household role rows remain in place.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS primary_household_id text
  REFERENCES households(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS people_primary_household_id_idx
  ON people(primary_household_id);

ALTER TABLE donor_payment_intermediaries
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS dpi_default_org_uq
  ON donor_payment_intermediaries(organization_id)
  WHERE organization_id IS NOT NULL AND is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS dpi_default_person_uq
  ON donor_payment_intermediaries(individual_giver_person_id)
  WHERE individual_giver_person_id IS NOT NULL AND is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS dpi_default_household_uq
  ON donor_payment_intermediaries(household_id)
  WHERE household_id IS NOT NULL AND is_default = true;

CREATE TABLE IF NOT EXISTS donor_routing_preferences (
  id text PRIMARY KEY,
  source_kind text NOT NULL,
  source_person_id text REFERENCES people(id) ON DELETE CASCADE,
  source_household_id text REFERENCES households(id) ON DELETE CASCADE,
  source_organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  mode text NOT NULL,
  target_kind text,
  target_person_id text REFERENCES people(id) ON DELETE RESTRICT,
  target_household_id text REFERENCES households(id) ON DELETE RESTRICT,
  target_organization_id text REFERENCES organizations(id) ON DELETE RESTRICT,
  updated_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT donor_routing_source_shape_ck CHECK (
    num_nonnulls(source_person_id, source_household_id, source_organization_id) = 1
    AND (
      (source_kind = 'individual' AND source_person_id IS NOT NULL)
      OR (source_kind = 'household' AND source_household_id IS NOT NULL)
      OR (source_kind = 'organization' AND source_organization_id IS NOT NULL)
    )
  ),
  CONSTRAINT donor_routing_target_shape_ck CHECK (
    (
      mode = 'ask'
      AND target_kind IS NULL
      AND num_nonnulls(target_person_id, target_household_id, target_organization_id) = 0
    ) OR (
      mode = 'target'
      AND target_kind IS NOT NULL
      AND num_nonnulls(target_person_id, target_household_id, target_organization_id) = 1
      AND (
        (target_kind = 'individual' AND target_person_id IS NOT NULL)
        OR (target_kind = 'household' AND target_household_id IS NOT NULL)
        OR (target_kind = 'organization' AND target_organization_id IS NOT NULL)
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS donor_routing_source_person_uq
  ON donor_routing_preferences(source_person_id)
  WHERE source_person_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donor_routing_source_household_uq
  ON donor_routing_preferences(source_household_id)
  WHERE source_household_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS donor_routing_source_org_uq
  ON donor_routing_preferences(source_organization_id)
  WHERE source_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS donor_routing_target_person_idx
  ON donor_routing_preferences(target_person_id);
CREATE INDEX IF NOT EXISTS donor_routing_target_household_idx
  ON donor_routing_preferences(target_household_id);
CREATE INDEX IF NOT EXISTS donor_routing_target_org_idx
  ON donor_routing_preferences(target_organization_id);

-- Backfill only unambiguous household relationships. If a person has several
-- distinct current households, leave the new authority blank for human review.
WITH current_households AS (
  SELECT
    person_id,
    array_agg(DISTINCT household_id) FILTER (WHERE household_id IS NOT NULL) AS household_ids
  FROM people_entity_roles
  WHERE entity_type = 'household' AND current = 'current'
  GROUP BY person_id
), unambiguous AS (
  SELECT person_id, household_ids[1] AS household_id
  FROM current_households
  WHERE cardinality(household_ids) = 1
)
UPDATE people p
SET primary_household_id = u.household_id,
    updated_at = now()
FROM unambiguous u
WHERE p.id = u.person_id
  AND p.primary_household_id IS NULL;
''',
)

write(
    "artifacts/api-server/src/lib/donorRouting.ts",
    r'''
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type DonorKind = "individual" | "household" | "organization";
export type EffectiveDonorRoutingMode = "self" | "target" | "ask";

export interface DonorRef {
  kind: DonorKind;
  id: string;
}

export interface DonorNode extends DonorRef {
  name: string;
  archived: boolean;
  anonymous: boolean;
  ownerUserId: string | null;
}

export interface StoredPreference {
  mode: "target" | "ask";
  target: DonorRef | null;
}

export interface DonorRoutingResolution {
  path: DonorNode[];
  resolved: DonorNode | null;
  requiresDecision: boolean;
}

export class DonorRoutingCycleError extends Error {
  constructor(public readonly path: DonorRef[]) {
    super("The preferred donor pathway contains a cycle.");
    this.name = "DonorRoutingCycleError";
  }
}

export class DonorRoutingDepthError extends Error {
  constructor() {
    super("The preferred donor pathway is too long.");
    this.name = "DonorRoutingDepthError";
  }
}

// Drizzle's transaction and database clients expose the same execute method,
// but their generic types are intentionally different. Keep this narrow helper
// structurally typed at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlExecutor = { execute: (query: any) => Promise<{ rows: unknown[] }> };

export const donorKey = (ref: DonorRef): string => `${ref.kind}:${ref.id}`;

export function sourceSql(ref: DonorRef) {
  if (ref.kind === "individual") {
    return sql`source_kind = 'individual' AND source_person_id = ${ref.id}`;
  }
  if (ref.kind === "household") {
    return sql`source_kind = 'household' AND source_household_id = ${ref.id}`;
  }
  return sql`source_kind = 'organization' AND source_organization_id = ${ref.id}`;
}

export async function loadDonorNode(
  exec: SqlExecutor,
  ref: DonorRef,
): Promise<DonorNode | null> {
  let result: { rows: unknown[] };
  if (ref.kind === "individual") {
    result = await exec.execute(sql`
      SELECT id,
             COALESCE(NULLIF(BTRIM(full_name), ''),
                      NULLIF(BTRIM(CONCAT_WS(' ', first_name, last_name)), ''),
                      'Person ' || id) AS name,
             archived_at IS NOT NULL AS archived,
             anonymous,
             owner_user_id
      FROM people WHERE id = ${ref.id} LIMIT 1
    `);
  } else if (ref.kind === "household") {
    result = await exec.execute(sql`
      SELECT id, name, archived_at IS NOT NULL AS archived,
             false AS anonymous, NULL::text AS owner_user_id
      FROM households WHERE id = ${ref.id} LIMIT 1
    `);
  } else {
    result = await exec.execute(sql`
      SELECT id, name, archived_at IS NOT NULL AS archived,
             anonymous, owner_user_id
      FROM organizations WHERE id = ${ref.id} LIMIT 1
    `);
  }
  const row = result.rows[0] as
    | {
        id: string;
        name: string;
        archived: boolean;
        anonymous: boolean;
        owner_user_id: string | null;
      }
    | undefined;
  return row
    ? {
        kind: ref.kind,
        id: row.id,
        name: row.name,
        archived: row.archived,
        anonymous: row.anonymous,
        ownerUserId: row.owner_user_id,
      }
    : null;
}

export async function getDirectDonorPreference(
  exec: SqlExecutor,
  source: DonorRef,
): Promise<StoredPreference | null> {
  const result = await exec.execute(sql`
    SELECT mode, target_kind, target_person_id, target_household_id,
           target_organization_id
    FROM donor_routing_preferences
    WHERE ${sourceSql(source)}
    LIMIT 1
  `);
  const row = result.rows[0] as
    | {
        mode: "target" | "ask";
        target_kind: DonorKind | null;
        target_person_id: string | null;
        target_household_id: string | null;
        target_organization_id: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.mode === "ask") return { mode: "ask", target: null };
  const id =
    row.target_kind === "individual"
      ? row.target_person_id
      : row.target_kind === "household"
        ? row.target_household_id
        : row.target_organization_id;
  return row.target_kind && id
    ? { mode: "target", target: { kind: row.target_kind, id } }
    : null;
}

export async function resolveDonorRouting(
  source: DonorRef,
  exec: SqlExecutor = db as unknown as SqlExecutor,
  override?: { source: DonorRef; preference: StoredPreference | null },
): Promise<DonorRoutingResolution> {
  const path: DonorNode[] = [];
  const visited = new Map<string, number>();
  let current = source;

  for (let depth = 0; depth < 12; depth += 1) {
    const key = donorKey(current);
    const seenAt = visited.get(key);
    if (seenAt != null) {
      throw new DonorRoutingCycleError(
        [...path.slice(seenAt).map(({ kind, id }) => ({ kind, id })), current],
      );
    }
    visited.set(key, path.length);
    const node = await loadDonorNode(exec, current);
    if (!node) return { path, resolved: null, requiresDecision: true };
    path.push(node);

    const pref =
      override && donorKey(override.source) === key
        ? override.preference
        : await getDirectDonorPreference(exec, current);
    if (!pref) return { path, resolved: node, requiresDecision: false };
    if (pref.mode === "ask") {
      return { path, resolved: null, requiresDecision: true };
    }
    if (!pref.target) return { path, resolved: node, requiresDecision: false };
    current = pref.target;
  }
  throw new DonorRoutingDepthError();
}
''',
)

write(
    "artifacts/api-server/src/routes/donorRouting.ts",
    r'''
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  donorPaymentIntermediaries,
  donorRoutingPreferences,
  households,
  paymentIntermediaries,
  people,
  peopleEntityRoles,
} from "@workspace/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  GetDonorRoutingParams,
  UpdateDonorRoutingBody,
  UpdateDonorRoutingParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, newId, notFound, parseOrBadRequest } from "../lib/helpers";
import { getAppUser } from "../lib/appRequest";
import { getViewer, maskName } from "../lib/identityVisibility";
import { recordAudit } from "../lib/audit";
import {
  DonorRoutingCycleError,
  DonorRoutingDepthError,
  donorKey,
  getDirectDonorPreference,
  loadDonorNode,
  resolveDonorRouting,
  sourceSql,
  type DonorKind,
  type DonorNode,
  type DonorRef,
  type SqlExecutor,
  type StoredPreference,
} from "../lib/donorRouting";

const router: IRouter = Router();
router.use(requireAuth);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function donorRef(kind: string, id: string): DonorRef | null {
  return kind === "individual" || kind === "household" || kind === "organization"
    ? { kind, id }
    : null;
}

function donorColumns(ref: DonorRef) {
  return {
    organizationId: ref.kind === "organization" ? ref.id : null,
    individualGiverPersonId: ref.kind === "individual" ? ref.id : null,
    householdId: ref.kind === "household" ? ref.id : null,
  };
}

function targetColumns(target: DonorRef | null) {
  return {
    targetKind: target?.kind ?? null,
    targetPersonId: target?.kind === "individual" ? target.id : null,
    targetHouseholdId: target?.kind === "household" ? target.id : null,
    targetOrganizationId: target?.kind === "organization" ? target.id : null,
  };
}

function sourceColumns(source: DonorRef) {
  return {
    sourceKind: source.kind,
    sourcePersonId: source.kind === "individual" ? source.id : null,
    sourceHouseholdId: source.kind === "household" ? source.id : null,
    sourceOrganizationId: source.kind === "organization" ? source.id : null,
  };
}

function displayNode(node: DonorNode, req: Parameters<typeof getViewer>[0]) {
  const viewer = getViewer(req);
  const name =
    node.kind === "household"
      ? node.name
      : maskName(
          node.name,
          { anonymous: node.anonymous, ownerUserId: node.ownerUserId },
          viewer,
        ) ?? "Anonymous";
  return { kind: node.kind, id: node.id, name };
}

async function defaultIntermediary(source: DonorRef) {
  const donor = donorColumns(source);
  const donorWhere = donor.organizationId
    ? eq(donorPaymentIntermediaries.organizationId, donor.organizationId)
    : donor.individualGiverPersonId
      ? eq(
          donorPaymentIntermediaries.individualGiverPersonId,
          donor.individualGiverPersonId,
        )
      : eq(donorPaymentIntermediaries.householdId, donor.householdId as string);
  const [row] = await db
    .select({
      id: paymentIntermediaries.id,
      name: paymentIntermediaries.name,
      type: paymentIntermediaries.type,
    })
    .from(donorPaymentIntermediaries)
    .innerJoin(
      paymentIntermediaries,
      eq(paymentIntermediaries.id, donorPaymentIntermediaries.paymentIntermediaryId),
    )
    .where(and(donorWhere, eq(donorPaymentIntermediaries.isDefault, true)))
    .limit(1);
  return row ?? null;
}

async function primaryHousehold(source: DonorRef) {
  if (source.kind !== "individual") return null;
  const [row] = await db
    .select({ id: households.id, name: households.name })
    .from(people)
    .leftJoin(households, eq(households.id, people.primaryHouseholdId))
    .where(eq(people.id, source.id))
    .limit(1);
  return row?.id ? row : null;
}

async function serializeSettings(req: Parameters<typeof getViewer>[0], source: DonorRef) {
  const sourceNode = await loadDonorNode(db as unknown as SqlExecutor, source);
  if (!sourceNode) return null;
  const direct = await getDirectDonorPreference(
    db as unknown as SqlExecutor,
    source,
  );
  const resolution = await resolveDonorRouting(source);
  const targetNode =
    direct?.mode === "target" && direct.target
      ? await loadDonorNode(db as unknown as SqlExecutor, direct.target)
      : null;
  const [household, intermediary] = await Promise.all([
    primaryHousehold(source),
    defaultIntermediary(source),
  ]);
  return {
    source: displayNode(sourceNode, req),
    mode: direct?.mode ?? "self",
    target: targetNode ? displayNode(targetNode, req) : null,
    resolved: resolution.resolved
      ? displayNode(resolution.resolved, req)
      : null,
    path: resolution.path.map((node) => displayNode(node, req)),
    requiresDecision: resolution.requiresDecision,
    primaryHousehold: household,
    defaultPaymentIntermediary: intermediary,
  };
}

async function syncPrimaryHousehold(
  tx: Tx,
  personId: string,
  householdId: string | null,
) {
  await tx
    .update(people)
    .set({ primaryHouseholdId: householdId, updatedAt: new Date() })
    .where(eq(people.id, personId));

  if (!householdId) {
    await tx
      .update(peopleEntityRoles)
      .set({ current: "past", updatedAt: new Date() })
      .where(
        and(
          eq(peopleEntityRoles.personId, personId),
          eq(peopleEntityRoles.entityType, "household"),
          eq(peopleEntityRoles.current, "current"),
        ),
      );
    return;
  }

  await tx
    .update(peopleEntityRoles)
    .set({ current: "past", updatedAt: new Date() })
    .where(
      and(
        eq(peopleEntityRoles.personId, personId),
        eq(peopleEntityRoles.entityType, "household"),
        eq(peopleEntityRoles.current, "current"),
        ne(peopleEntityRoles.householdId, householdId),
      ),
    );
  const [existing] = await tx
    .select()
    .from(peopleEntityRoles)
    .where(
      and(
        eq(peopleEntityRoles.personId, personId),
        eq(peopleEntityRoles.householdId, householdId),
      ),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(peopleEntityRoles)
      .set({ current: "current", updatedAt: new Date() })
      .where(eq(peopleEntityRoles.id, existing.id));
  } else {
    await tx.insert(peopleEntityRoles).values({
      id: newId(),
      personId,
      entityType: "household",
      householdId,
      current: "current",
    });
  }
}

async function setDefaultIntermediary(
  tx: Tx,
  source: DonorRef,
  paymentIntermediaryId: string | null,
) {
  const donor = donorColumns(source);
  const donorWhere = donor.organizationId
    ? eq(donorPaymentIntermediaries.organizationId, donor.organizationId)
    : donor.individualGiverPersonId
      ? eq(
          donorPaymentIntermediaries.individualGiverPersonId,
          donor.individualGiverPersonId,
        )
      : eq(donorPaymentIntermediaries.householdId, donor.householdId as string);
  await tx
    .update(donorPaymentIntermediaries)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(donorWhere, eq(donorPaymentIntermediaries.isDefault, true)));
  if (!paymentIntermediaryId) return;

  const [pi] = await tx
    .select({ id: paymentIntermediaries.id, archivedAt: paymentIntermediaries.archivedAt })
    .from(paymentIntermediaries)
    .where(eq(paymentIntermediaries.id, paymentIntermediaryId))
    .limit(1);
  if (!pi || pi.archivedAt) throw new Error("default_intermediary_unavailable");

  const [existing] = await tx
    .select({ id: donorPaymentIntermediaries.id })
    .from(donorPaymentIntermediaries)
    .where(
      and(
        donorWhere,
        eq(
          donorPaymentIntermediaries.paymentIntermediaryId,
          paymentIntermediaryId,
        ),
      ),
    )
    .limit(1);
  if (existing) {
    await tx
      .update(donorPaymentIntermediaries)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(donorPaymentIntermediaries.id, existing.id));
  } else {
    await tx.insert(donorPaymentIntermediaries).values({
      id: newId(),
      ...donor,
      paymentIntermediaryId,
      isDefault: true,
    });
  }
}

router.get(
  "/donor-routing/:sourceKind/:sourceId",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(GetDonorRoutingParams, req.params, res);
    if (!params) return;
    const source = donorRef(params.sourceKind, params.sourceId);
    if (!source) {
      res.status(400).json({ error: "invalid_donor_kind", message: "Invalid donor kind." });
      return;
    }
    const settings = await serializeSettings(req, source);
    if (!settings) return notFound(res, "donor");
    res.json(settings);
  }),
);

router.put(
  "/donor-routing/:sourceKind/:sourceId",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(UpdateDonorRoutingParams, req.params, res);
    const body = parseOrBadRequest(UpdateDonorRoutingBody, req.body, res);
    if (!params || !body) return;
    const source = donorRef(params.sourceKind, params.sourceId);
    if (!source) {
      res.status(400).json({ error: "invalid_donor_kind", message: "Invalid donor kind." });
      return;
    }
    const sourceNode = await loadDonorNode(db as unknown as SqlExecutor, source);
    if (!sourceNode) return notFound(res, "donor");
    if (sourceNode.archived) {
      res.status(409).json({
        error: "donor_archived",
        message: "Restore this donor before changing its preferred pathway.",
      });
      return;
    }

    const target =
      body.mode === "target" && body.targetKind && body.targetId
        ? donorRef(body.targetKind, body.targetId)
        : null;
    if (body.mode === "target" && !target) {
      res.status(400).json({
        error: "target_required",
        message: "Choose the donor record this pathway should use.",
      });
      return;
    }
    if (target && donorKey(target) === donorKey(source)) {
      res.status(400).json({
        error: "self_target",
        message: "Use the 'This record' option instead of pointing a donor to itself.",
      });
      return;
    }
    if (target) {
      const targetNode = await loadDonorNode(db as unknown as SqlExecutor, target);
      if (!targetNode || targetNode.archived) {
        res.status(409).json({
          error: "target_unavailable",
          message: "The preferred donor target is missing or archived.",
        });
        return;
      }
    }
    if (source.kind !== "individual" && body.primaryHouseholdId) {
      res.status(400).json({
        error: "primary_household_not_allowed",
        message: "Only an individual can have a primary household.",
      });
      return;
    }
    if (body.primaryHouseholdId) {
      const [household] = await db
        .select({ id: households.id, archivedAt: households.archivedAt })
        .from(households)
        .where(eq(households.id, body.primaryHouseholdId))
        .limit(1);
      if (!household || household.archivedAt) {
        res.status(409).json({
          error: "primary_household_unavailable",
          message: "The selected primary household is missing or archived.",
        });
        return;
      }
    }

    const proposed: StoredPreference | null =
      body.mode === "self"
        ? null
        : body.mode === "ask"
          ? { mode: "ask", target: null }
          : { mode: "target", target };
    try {
      await resolveDonorRouting(source, db as unknown as SqlExecutor, {
        source,
        preference: proposed,
      });
    } catch (error) {
      if (error instanceof DonorRoutingCycleError) {
        res.status(409).json({
          error: "donor_routing_cycle",
          message: "That change would create a circular preferred donor pathway.",
        });
        return;
      }
      if (error instanceof DonorRoutingDepthError) {
        res.status(409).json({
          error: "donor_routing_too_deep",
          message: "That preferred donor pathway is too long.",
        });
        return;
      }
      throw error;
    }

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${donorKey(source)}))`);
        const before = await getDirectDonorPreference(
          tx as unknown as SqlExecutor,
          source,
        );
        await tx.execute(sql`DELETE FROM donor_routing_preferences WHERE ${sourceSql(source)}`);
        const actor = getAppUser(req);
        if (proposed) {
          await tx.insert(donorRoutingPreferences).values({
            id: newId(),
            ...sourceColumns(source),
            mode: proposed.mode,
            ...targetColumns(proposed.target),
            updatedByUserId: actor?.id ?? null,
          });
        }
        if (source.kind === "individual") {
          await syncPrimaryHousehold(
            tx,
            source.id,
            body.primaryHouseholdId ?? null,
          );
        }
        await setDefaultIntermediary(
          tx,
          source,
          body.defaultPaymentIntermediaryId ?? null,
        );
        await recordAudit(tx, req, {
          action: "update",
          entityType: source.kind === "individual" ? "person" : source.kind,
          entityId: source.id,
          summary: `Updated preferred donor settings for ${sourceNode.name}`,
          metadata: {
            donorRouting: {
              before,
              after: proposed,
              primaryHouseholdId: body.primaryHouseholdId ?? null,
              defaultPaymentIntermediaryId:
                body.defaultPaymentIntermediaryId ?? null,
            },
          },
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === "default_intermediary_unavailable") {
        res.status(409).json({
          error: "default_intermediary_unavailable",
          message: "The selected payment intermediary is missing or archived.",
        });
        return;
      }
      throw error;
    }

    const settings = await serializeSettings(req, source);
    if (!settings) return notFound(res, "donor");
    res.json(settings);
  }),
);

export default router;
''',
)

replace_once(
    "artifacts/api-server/src/routes/index.ts",
    'import donorPaymentIntermediariesRouter from "./donorPaymentIntermediaries";\n',
    'import donorPaymentIntermediariesRouter from "./donorPaymentIntermediaries";\nimport donorRoutingRouter from "./donorRouting";\n',
    "donor routing route import",
)
replace_once(
    "artifacts/api-server/src/routes/index.ts",
    'router.use(donorPaymentIntermediariesRouter);\n',
    'router.use(donorPaymentIntermediariesRouter);\nrouter.use(donorRoutingRouter);\n',
    "donor routing route mount",
)

# Keep the direct primary-household authority in sync with the transitional role UI.
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    'import { peopleEntityRoles } from "@workspace/db/schema";\n',
    'import { people, peopleEntityRoles } from "@workspace/db/schema";\n',
    "people role people import",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''async function demoteOtherPrimaries(
  tx: Tx,
  row: typeof peopleEntityRoles.$inferSelect,
) {
''',
    '''async function syncPrimaryHousehold(
  tx: Tx,
  before: typeof peopleEntityRoles.$inferSelect | null,
  after: typeof peopleEntityRoles.$inferSelect | null,
) {
  const active =
    after?.entityType === "household" &&
    after.householdId &&
    after.current === "current"
      ? after
      : null;
  if (active) {
    await tx
      .update(peopleEntityRoles)
      .set({ current: "past", updatedAt: new Date() })
      .where(
        and(
          eq(peopleEntityRoles.personId, active.personId),
          eq(peopleEntityRoles.entityType, "household"),
          eq(peopleEntityRoles.current, "current"),
          ne(peopleEntityRoles.id, active.id),
        ),
      );
    await tx
      .update(people)
      .set({ primaryHouseholdId: active.householdId, updatedAt: new Date() })
      .where(eq(people.id, active.personId));
    return;
  }
  if (before?.householdId) {
    await tx
      .update(people)
      .set({ primaryHouseholdId: null, updatedAt: new Date() })
      .where(
        and(
          eq(people.id, before.personId),
          eq(people.primaryHouseholdId, before.householdId),
        ),
      );
  }
}

async function demoteOtherPrimaries(
  tx: Tx,
  row: typeof peopleEntityRoles.$inferSelect,
) {
''',
    "people role household sync helper",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''      if (created?.primaryContact) await demoteOtherPrimaries(tx, created);
      return created;
''',
    '''      if (created?.primaryContact) await demoteOtherPrimaries(tx, created);
      if (created) await syncPrimaryHousehold(tx, null, created);
      return created;
''',
    "people role create sync",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
''',
    '''    const row = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(peopleEntityRoles)
        .where(eq(peopleEntityRoles.id, paramId(req)))
        .limit(1);
      const [updated] = await tx
''',
    "people role patch before",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''      if (updated?.primaryContact) {
        await demoteOtherPrimaries(tx, updated);
      }
      return updated;
''',
    '''      if (updated?.primaryContact) {
        await demoteOtherPrimaries(tx, updated);
      }
      await syncPrimaryHousehold(tx, before ?? null, updated ?? null);
      return updated;
''',
    "people role patch sync",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''  asyncHandler(async (req, res) => {
    await db.delete(peopleEntityRoles).where(eq(peopleEntityRoles.id, paramId(req)));
    res.status(204).end();
  }),
''',
    '''  asyncHandler(async (req, res) => {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(peopleEntityRoles)
        .where(eq(peopleEntityRoles.id, paramId(req)))
        .limit(1);
      await tx
        .delete(peopleEntityRoles)
        .where(eq(peopleEntityRoles.id, paramId(req)));
      await syncPrimaryHousehold(tx, before ?? null, null);
    });
    res.status(204).end();
  }),
''',
    "people role delete sync",
)

# OpenAPI: add a dedicated tag, route, and response/body schemas.
replace_once(
    "lib/api-spec/openapi.yaml",
    '  - { name: donor-payment-intermediaries }\n',
    '  - { name: donor-payment-intermediaries }\n  - { name: donor-routing }\n',
    "openapi donor routing tag",
)
replace_once(
    "lib/api-spec/openapi.yaml",
    '''  # ─── Cleanup queue (records flagged for manual data cleanup) ─────────────────
''',
    '''  # ─── Preferred donor pathways ───────────────────────────────────────────────
  /donor-routing/{sourceKind}/{sourceId}:
    get:
      operationId: getDonorRouting
      tags: [donor-routing]
      summary: Get the effective preferred donor pathway, primary household, and default intermediary for a donor record.
      parameters:
        - { name: sourceKind, in: path, required: true, schema: { $ref: "#/components/schemas/DonorRecordKind" } }
        - { name: sourceId, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/DonorRoutingSettings" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
    put:
      operationId: updateDonorRouting
      tags: [donor-routing]
      summary: Replace a donor record's preferred pathway and related donor defaults.
      parameters:
        - { name: sourceKind, in: path, required: true, schema: { $ref: "#/components/schemas/DonorRecordKind" } }
        - { name: sourceId, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/UpdateDonorRoutingBody" } } }
      responses:
        "200": { description: Updated, content: { application/json: { schema: { $ref: "#/components/schemas/DonorRoutingSettings" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { description: The pathway is circular, unavailable, or otherwise unsafe. }

  # ─── Cleanup queue (records flagged for manual data cleanup) ─────────────────
''',
    "openapi donor routing path",
)
replace_once(
    "lib/api-spec/openapi.yaml",
    '''    CleanupQueueStatus:
''',
    '''    DonorRecordKind:
      type: string
      enum: [individual, household, organization]
    DonorRoutingMode:
      type: string
      enum: [self, target, ask]
    DonorReference:
      type: object
      required: [kind, id, name]
      properties:
        kind: { $ref: "#/components/schemas/DonorRecordKind" }
        id: { type: string }
        name: { type: string }
    DonorRoutingIntermediaryReference:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
        type: { type: string, nullable: true }
    DonorRoutingHouseholdReference:
      type: object
      required: [id, name]
      properties:
        id: { type: string }
        name: { type: string }
    DonorRoutingSettings:
      type: object
      required: [source, mode, target, resolved, path, requiresDecision, primaryHousehold, defaultPaymentIntermediary]
      properties:
        source: { $ref: "#/components/schemas/DonorReference" }
        mode: { $ref: "#/components/schemas/DonorRoutingMode" }
        target:
          anyOf:
            - { $ref: "#/components/schemas/DonorReference" }
            - { type: "null" }
        resolved:
          anyOf:
            - { $ref: "#/components/schemas/DonorReference" }
            - { type: "null" }
        path:
          type: array
          items: { $ref: "#/components/schemas/DonorReference" }
        requiresDecision: { type: boolean }
        primaryHousehold:
          anyOf:
            - { $ref: "#/components/schemas/DonorRoutingHouseholdReference" }
            - { type: "null" }
        defaultPaymentIntermediary:
          anyOf:
            - { $ref: "#/components/schemas/DonorRoutingIntermediaryReference" }
            - { type: "null" }
    UpdateDonorRoutingBody:
      type: object
      required: [mode, targetKind, targetId, primaryHouseholdId, defaultPaymentIntermediaryId]
      properties:
        mode: { $ref: "#/components/schemas/DonorRoutingMode" }
        targetKind:
          anyOf:
            - { $ref: "#/components/schemas/DonorRecordKind" }
            - { type: "null" }
        targetId: { type: [string, "null"] }
        primaryHouseholdId: { type: [string, "null"] }
        defaultPaymentIntermediaryId: { type: [string, "null"] }

    CleanupQueueStatus:
''',
    "openapi donor routing schemas",
)

print("preferred donor schema and API patch applied")
