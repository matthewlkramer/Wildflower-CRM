import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizationTypeEnum } from "./_enums";

// Non-funder external organizations (advisors, intermediaries, etc.).
//
// Contact info lives in normalized tables:
//   - email      → `emails` (FK `organization_id`)
//   - phone      → `phone_numbers` (FK `organization_id`)
//   - address    → `addresses` (FK `organization_id`)
// Region attribution moves with the address.
export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: organizationTypeEnum("type"),
  emailDomain: text("email_domain"),
  // FK to users.id — team member who owns this organization.
  ownerUserId: text("owner_user_id"),
  tags: text("tags"),
  website: text("website"),
  activeOrDefunct: text("active_or_defunct"),
  otherNames: text("other_names"),
  parentOrgId: text("parent_org_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
