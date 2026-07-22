import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Server-side region containment authority.
 *
 * "Region X contains region Y" is derived recursively over TWO edge sets:
 *   1. canonical parentage — regions.parent_region_id (natural geography:
 *      US → Massachusetts → Boston → Roxbury);
 *   2. grouping memberships — region_memberships (business groupings:
 *      New England → Massachusetts, Twin Cities → Minneapolis).
 *
 * Nothing is stored: this module is the single derivation point. Callers are
 * the /regions/containment endpoint (picker redundancy hints + filter
 * expansion indicator) and the list-route region filters (containment-aware
 * matching). A depth cap bounds accidental cycles; writes are cycle-checked
 * with wouldFinalGraphCycle — which validates the INTENDED FINAL graph (parent
 * and membership changes applied together), not field-by-field pre-state —
 * before any parent/membership write.
 */

const MAX_DEPTH = 12;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

function textArray(ids: string[]) {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]`;
}

/**
 * For each root id, every region id recursively contained in it (excluding
 * the root itself). Unknown ids yield empty arrays.
 */
export async function deriveContainment(
  rootIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(rootIds.map((id) => [id, []]));
  const unique = [...new Set(rootIds)];
  if (unique.length === 0) return out;

  const result = await db.execute(sql`
    WITH RECURSIVE walk AS (
      SELECT r.id AS root, r.id AS node, 0 AS depth
      FROM regions r
      WHERE r.id = ANY(${textArray(unique)})
      UNION
      SELECT w.root, e.node, w.depth + 1
      FROM walk w
      JOIN (
        SELECT c.parent_region_id AS via, c.id AS node
        FROM regions c
        WHERE c.parent_region_id IS NOT NULL
        UNION ALL
        SELECT m.container_region_id AS via, m.member_region_id AS node
        FROM region_memberships m
      ) e ON e.via = w.node
      WHERE w.depth < ${MAX_DEPTH}
    )
    SELECT root, array_agg(DISTINCT node) FILTER (WHERE node <> root) AS contained
    FROM walk
    GROUP BY root
  `);
  for (const row of result.rows as { root: string; contained: string[] | null }[]) {
    out.set(row.root, row.contained ?? []);
  }
  return out;
}

/**
 * Expand a filter's region id set to include every contained region. Returns
 * the union of the input ids and all their contained ids — the id set that a
 * containment-aware array-overlap filter should match against.
 */
export async function expandRegionIdsForFilter(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const map = await deriveContainment(ids);
  const set = new Set(ids);
  for (const contained of map.values()) for (const id of contained) set.add(id);
  return [...set];
}

/**
 * True when the INTENDED FINAL containment graph — current edges with the
 * candidate region's parent edge and/or membership edge set replaced by the
 * proposed values — contains a cycle.
 *
 * Field-by-field pre-state checks are insufficient: a single request that
 * sets `parentRegionId = P` AND adds `P` to `memberRegionIds` passes both
 * individual checks against the current graph yet creates `P → region` and
 * `region → P` together. Only edges touching `regionId` change, so any new
 * cycle must pass through `regionId`; a reachability walk from it over the
 * final graph is therefore complete.
 *
 * Semantics: `parentRegionId`/`memberRegionIds` left `undefined` keep the
 * region's current edges (PATCH partial-update semantics). For a region being
 * created, pass both explicitly (the region has no current edges).
 */
export async function wouldFinalGraphCycle(
  candidate: {
    regionId: string;
    parentRegionId?: string | null;
    memberRegionIds?: string[];
  },
  executor: Executor = db,
): Promise<boolean> {
  const { regionId, parentRegionId, memberRegionIds } = candidate;
  if (parentRegionId === regionId) return true;
  if (memberRegionIds?.includes(regionId)) return true;

  // Current edges, minus any edge set the candidate replaces.
  const result = await executor.execute(sql`
    SELECT r.parent_region_id AS container, r.id AS member
    FROM regions r
    WHERE r.parent_region_id IS NOT NULL
      ${parentRegionId !== undefined ? sql`AND r.id <> ${regionId}` : sql``}
    UNION ALL
    SELECT m.container_region_id AS container, m.member_region_id AS member
    FROM region_memberships m
    ${memberRegionIds !== undefined ? sql`WHERE m.container_region_id <> ${regionId}` : sql``}
  `);

  const children = new Map<string, string[]>();
  const addEdge = (container: string, member: string) => {
    const list = children.get(container);
    if (list) list.push(member);
    else children.set(container, [member]);
  };
  for (const row of result.rows as { container: string; member: string }[]) {
    addEdge(row.container, row.member);
  }
  if (parentRegionId != null) addEdge(parentRegionId, regionId);
  for (const memberId of memberRegionIds ?? []) addEdge(regionId, memberId);

  // Cycle iff regionId is reachable from its own contained set.
  const stack = [...(children.get(regionId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === regionId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of children.get(node) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Recompute the derived display_path for every region from canonical
 * parentage (comma-joined names, root → self). Full-table: the regions table
 * is small (~600 rows) and a single statement keeps the derivation identical
 * everywhere (matches migration 0154 exactly). Accepts a transaction so
 * callers can recompute atomically with the write that changed parentage.
 */
export async function recomputeDisplayPaths(executor: Executor = db): Promise<void> {
  await executor.execute(sql`
    WITH RECURSIVE paths AS (
      SELECT id, parent_region_id, name::text AS path, 1 AS depth
      FROM regions
      WHERE parent_region_id IS NULL
      UNION ALL
      SELECT r.id, r.parent_region_id, p.path || ', ' || r.name, p.depth + 1
      FROM regions r
      JOIN paths p ON p.id = r.parent_region_id
      WHERE p.depth < ${MAX_DEPTH}
    )
    UPDATE regions r
    SET display_path = paths.path, updated_at = now()
    FROM paths
    WHERE r.id = paths.id AND r.display_path IS DISTINCT FROM paths.path
  `);
}
