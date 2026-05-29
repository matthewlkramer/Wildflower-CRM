/**
 * One-off, idempotent maintenance script that resolves the legacy
 * `<clerkId>@unknown.com` placeholder user rows created when a user signed
 * in without an `email` claim in their session token.
 *
 * For each placeholder row (`ph`, which carries the user's REAL Clerk id and
 * any personal email/calendar data synced under it):
 *   1. Look the user up in Clerk by `clerkId`.
 *   2. If Clerk returns a real email:
 *        - If another user row already exists with that email (a pre-seeded
 *          placeholder backfilled from legacy `owner` text columns), MERGE
 *          by keeping `ph` (so the real Clerk id + personal data survive and
 *          future logins still resolve): re-point EVERY foreign-key
 *          reference from the duplicate onto `ph`, delete the duplicate, then
 *          set `ph`'s email + name to the real values.
 *        - Otherwise backfill `ph` in place with the real email and name.
 *   3. If Clerk can't resolve the user, archive (soft-delete) the row so it
 *      stays out of owner pickers without breaking historical references.
 *
 * Re-pointing is done dynamically from information_schema so every FK that
 * references users.id is covered (owner_user_id on the entity tables plus
 * creator/assignee/resolved-by columns on saved_views, notes, tasks,
 * meeting_notes, email_proposals, and the cascade email/calendar tables) —
 * all FKs are ON DELETE RESTRICT/CASCADE, so the delete would otherwise fail.
 *
 * Safe to re-run: rows already backfilled no longer match the
 * `%@unknown.com` filter.
 *
 * Run with: pnpm --filter @workspace/api-server run backfill:user-identities
 */
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq, like, sql } from "drizzle-orm";
import { fetchClerkIdentity } from "../lib/clerkIdentity";

type FkRef = { table: string; column: string };

/** Every column in the DB that has a FK to users.id. */
async function userFkColumns(): Promise<FkRef[]> {
  const result = await db.execute<{ table_name: string; column_name: string }>(
    sql`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_name = 'users'
        AND ccu.column_name = 'id'
    `,
  );
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? result;
  return (rows as { table_name: string; column_name: string }[]).map((r) => ({
    table: r.table_name,
    column: r.column_name,
  }));
}

/** Re-point every users.id FK reference from `fromId` to `toId`. */
async function repointAll(
  fks: FkRef[],
  fromId: string,
  toId: string,
): Promise<number> {
  let moved = 0;
  for (const { table, column } of fks) {
    const res = await db.execute(
      sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${toId} WHERE ${sql.identifier(column)} = ${fromId}`,
    );
    moved += (res as unknown as { rowCount?: number }).rowCount ?? 0;
  }
  return moved;
}

async function main(): Promise<void> {
  const fks = await userFkColumns();
  console.log(`Discovered ${fks.length} FK column(s) referencing users.id.`);

  const placeholders = await db
    .select()
    .from(users)
    .where(like(users.email, "%@unknown.com"));

  console.log(`Found ${placeholders.length} placeholder user row(s).`);

  let backfilled = 0;
  let merged = 0;
  let archived = 0;

  for (const ph of placeholders) {
    const identity = await fetchClerkIdentity(ph.clerkId);

    if (!identity?.email) {
      // Clerk can't resolve this user — archive so it stays out of pickers
      // while preserving any historical owner references.
      if (!ph.archivedAt) {
        await db
          .update(users)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(users.id, ph.id));
      }
      archived++;
      console.log(`  [archive] ${ph.id} (${ph.clerkId}) — unresolvable`);
      continue;
    }

    const dup = await db
      .select()
      .from(users)
      .where(eq(users.email, identity.email))
      .then((rows) => rows.find((u) => u.id !== ph.id));

    if (dup) {
      // Keep `ph` (real Clerk id + personal data). Re-point the duplicate's
      // references onto `ph`, delete the duplicate, then claim the real
      // email + name. Free `email` on the duplicate first so `ph` can take
      // it without tripping the unique constraint.
      const moved = await repointAll(fks, dup.id, ph.id);
      await db.delete(users).where(eq(users.id, dup.id));
      await db
        .update(users)
        .set({
          email: identity.email,
          firstName: ph.firstName ?? dup.firstName ?? identity.firstName,
          lastName: ph.lastName ?? dup.lastName ?? identity.lastName,
          displayName:
            ph.displayName ?? dup.displayName ?? identity.displayName,
          // If the duplicate was archived, preserve that denial.
          archivedAt: ph.archivedAt ?? dup.archivedAt,
          updatedAt: new Date(),
        })
        .where(eq(users.id, ph.id));
      merged++;
      console.log(
        `  [merge]   ${dup.id} -> ${ph.id} (${identity.email}), re-pointed ${moved} ref(s)`,
      );
    } else {
      // No collision — backfill the placeholder in place.
      await db
        .update(users)
        .set({
          email: identity.email,
          firstName: ph.firstName ?? identity.firstName,
          lastName: ph.lastName ?? identity.lastName,
          displayName: ph.displayName ?? identity.displayName,
          updatedAt: new Date(),
        })
        .where(eq(users.id, ph.id));
      backfilled++;
      console.log(`  [backfill] ${ph.id} -> ${identity.email}`);
    }
  }

  console.log(
    `\nDone. backfilled=${backfilled} merged=${merged} archived=${archived}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("User-identity backfill failed:", err);
    process.exit(1);
  });
