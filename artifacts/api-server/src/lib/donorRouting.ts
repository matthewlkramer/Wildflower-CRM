import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type DonorKind = "individual" | "household" | "organization";
export type EffectiveDonorRoutingMode = "automatic" | "self" | "target" | "ask";

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
  mode: "self" | "target" | "ask";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SqlExecutor = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

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
        mode: "self" | "target" | "ask";
        target_kind: DonorKind | null;
        target_person_id: string | null;
        target_household_id: string | null;
        target_organization_id: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.mode === "self") return { mode: "self", target: null };
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

async function implicitAutomaticTarget(
  exec: SqlExecutor,
  source: DonorRef,
): Promise<DonorRef | null> {
  if (source.kind !== "individual") return null;
  const result = await exec.execute(sql`
    SELECT primary_household_id
    FROM people
    WHERE id = ${source.id}
    LIMIT 1
  `);
  const row = result.rows[0] as
    | { primary_household_id: string | null }
    | undefined;
  return row?.primary_household_id
    ? { kind: "household", id: row.primary_household_id }
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
      throw new DonorRoutingCycleError([
        ...path.slice(seenAt).map(({ kind, id }) => ({ kind, id })),
        current,
      ]);
    }
    visited.set(key, path.length);
    const node = await loadDonorNode(exec, current);
    if (!node) return { path, resolved: null, requiresDecision: true };
    path.push(node);

    const pref =
      override && donorKey(override.source) === key
        ? override.preference
        : await getDirectDonorPreference(exec, current);
    if (!pref) {
      const automatic = await implicitAutomaticTarget(exec, current);
      if (!automatic) return { path, resolved: node, requiresDecision: false };
      current = automatic;
      continue;
    }
    if (pref.mode === "self") {
      return { path, resolved: node, requiresDecision: false };
    }
    if (pref.mode === "ask") {
      return { path, resolved: null, requiresDecision: true };
    }
    if (!pref.target) return { path, resolved: node, requiresDecision: false };
    current = pref.target;
  }
  throw new DonorRoutingDepthError();
}
