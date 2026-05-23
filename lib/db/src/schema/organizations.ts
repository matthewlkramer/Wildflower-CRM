import { type AnyPgColumn, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationTypeEnum } from "./_enums";
import { users } from "./users";

// Non-funder external organizations (advisors, intermediaries, etc.).
//
// Contact info lives in normalized tables:
//   - email      → `emails` (FK `organization_id`)
//   - phone      → `phone_numbers` (FK `organization_id` — NOT YET — see #6)
//   - address    → `addresses` (FK `organization_id`)
// Region attribution moves with the address.
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: organizationTypeEnum("type"),
  emailDomain: text("email_domain"),
  // Team member who owns this org. RESTRICT preserves history when a team
  // member archives.
  ownerUserId: text("owner_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  tags: text("tags"),
  website: text("website"),
  activeOrDefunct: text("active_or_defunct"),
  otherNames: text("other_names"),
  // Prior names the org has been known by (e.g. rebrands, mergers).
  // Distinct from `otherNames` which holds current aliases / DBAs.
  historicalNames: text("historical_names").array(),
  // Self-ref. SET NULL: removing a parent org leaves children intact.
  parentOrgId: text("parent_org_id").references(
    (): AnyPgColumn => organizations.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("organizations_owner_user_id_idx").on(t.ownerUserId),
  index("organizations_parent_org_id_idx").on(t.parentOrgId),
]);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
