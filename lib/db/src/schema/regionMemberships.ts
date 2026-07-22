import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { regions } from "./regions";

/**
 * Flexible business-grouping membership: `container` region INCLUDES `member`
 * region (e.g. New England → Massachusetts, Twin Cities → Minneapolis).
 * Kept SEPARATE from regions.parent_region_id, which holds only natural
 * geographic parentage (US → Massachusetts → Boston). Containment is derived
 * recursively over BOTH relationships by the server-side containment
 * authority; no stored closure.
 *
 * Structural link rows (like other pure join tables): hard-deleted when an
 * admin edits a region's member set — there is no archived_at here by design.
 * Cycle prevention beyond the self-link CHECK is enforced by the write
 * endpoint via the containment derivation before insert.
 */
export const regionMemberships = pgTable(
  "region_memberships",
  {
    id: text("id").primaryKey(),
    // CASCADE: removing a grouping region removes its membership links; the
    // member regions themselves are untouched.
    containerRegionId: text("container_region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "cascade" }),
    memberRegionId: text("member_region_id")
      .notNull()
      .references(() => regions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("region_memberships_container_member_uq").on(
      t.containerRegionId,
      t.memberRegionId,
    ),
    index("region_memberships_member_region_id_idx").on(t.memberRegionId),
    check(
      "region_memberships_no_self_link",
      sql`${t.containerRegionId} <> ${t.memberRegionId}`,
    ),
  ],
);

export type RegionMembership = typeof regionMemberships.$inferSelect;
export type NewRegionMembership = typeof regionMemberships.$inferInsert;
