import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

/**
 * Per-list-page saved views. Captures the page's filter + sort state
 * as opaque JSON so the page owns its own state shape — the server is
 * a dumb store.
 *
 * Visibility:
 *   - 'team':       visible to everyone, editable/deletable only by the
 *                   creator. Use for shared workflows ("Q2 prospects").
 *   - 'individual': visible only to the creator. Use for personal cuts.
 *
 * `listKey` is the page identifier (e.g. "individuals", "funders",
 * "opportunities"). The hook on the client picks the key per page.
 *
 * Creator ownership is enforced at the API layer (PATCH/DELETE require
 * creatorUserId === caller) rather than via row-level security so the
 * route can return a clean 403.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    listKey: text("list_key").notNull(),
    name: text("name").notNull(),
    visibility: text("visibility").notNull(),
    // Opaque page state — {filters: {...}, sort: {key, dir}}. The server
    // does not introspect this; the client picks the shape per list.
    state: jsonb("state").notNull(),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("saved_views_list_key_visibility_idx").on(t.listKey, t.visibility),
    index("saved_views_creator_user_id_idx").on(t.creatorUserId),
    check(
      "saved_views_visibility_chk",
      sql`${t.visibility} IN ('team', 'individual')`,
    ),
  ],
);

export type SavedViewRow = typeof savedViews.$inferSelect;
export type NewSavedViewRow = typeof savedViews.$inferInsert;
