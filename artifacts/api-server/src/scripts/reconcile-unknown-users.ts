/**
 * One-shot reconciliation for orphaned `@unknown.com` user rows.
 *
 * Background: before the auth middleware learned to resolve a signer's
 * email from the Clerk backend, every real sign-in fell through the
 * "claim an existing seeded row by email" branch (Clerk omits `email`
 * from session claims by default) and instead provisioned a fresh blank
 * row with a `<clerkId>@unknown.com` email. Those orphan rows own no
 * funders, so "My top priorities" and other current-user-scoped views
 * came back empty.
 *
 * This script, for each `@unknown.com` row:
 *   1. Resolves the person's real email via the Clerk backend (by clerk id).
 *   2. If a pre-seeded team-member row matches that email, MERGES the orphan
 *      into the seeded row: re-points the seeded row's clerkId to the live
 *      Clerk id and deletes the orphan, so the live session now resolves to
 *      the funder-owning seeded record.
 *   3. If no seeded match exists, leaves the row but corrects its email to
 *      the real address (only when that address is not already taken).
 *   4. If the email can't be resolved (e.g. Clerk user deleted), skips it.
 *
 * Idempotent — safe to re-run. After a successful merge there are no more
 * `@unknown.com` rows for that person, so a second run is a no-op.
 *
 * Run with: pnpm --filter @workspace/api-server run reconcile:unknown-users
 */
import { db } from "@workspace/db";
import { users } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { resolveClerkEmail } from "../lib/resolveClerkEmail";

/**
 * Every (table, column) in the public schema whose foreign key targets
 * users(id). Read from information_schema so we never miss a reference and
 * the merge stays correct even as new owner_user_id columns are added.
 */
async function usersFkColumns(): Promise<Array<{ table: string; column: string }>> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT kcu.table_name, kcu.column_name
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
  `);
  return (rows.rows ?? rows).map((r) => ({
    table: r.table_name,
    column: r.column_name,
  }));
}

async function main(): Promise<void> {
  const fkCols = await usersFkColumns();
  const all = await db.select().from(users);
  const unknowns = all.filter((u) => u.email.endsWith("@unknown.com"));
  console.log(`Found ${unknowns.length} @unknown.com rows to reconcile.`);

  let merged = 0;
  let corrected = 0;
  let skipped = 0;

  for (const orphan of unknowns) {
    const realEmail = await resolveClerkEmail(orphan.clerkId, undefined);
    if (!realEmail) {
      console.log(`  skip ${orphan.clerkId}: could not resolve email`);
      skipped++;
      continue;
    }

    const match = all.find(
      (u) => u.email === realEmail && u.id !== orphan.id,
    );

    if (match) {
      // Merge: the seeded row (`match`) owns the funders; the orphan holds
      // the live Clerk id and possibly records created during the failed
      // sessions. Re-point every FK reference from orphan → match, delete
      // the orphan, then move the live clerkId onto the seeded row so the
      // live session resolves to the funder-owning record. All in one
      // transaction; the orphan is deleted before the clerkId moves so the
      // unique clerk_id constraint never sees a collision.
      try {
        await db.transaction(async (tx) => {
          for (const { table, column } of fkCols) {
            await tx.execute(
              sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${match.id} WHERE ${sql.identifier(column)} = ${orphan.id}`,
            );
          }
          await tx.delete(users).where(eq(users.id, orphan.id));
          await tx
            .update(users)
            .set({ clerkId: orphan.clerkId, updatedAt: new Date() })
            .where(eq(users.id, match.id));
        });
        console.log(
          `  merged ${orphan.clerkId} (${orphan.email}) → ${match.email}`,
        );
        merged++;
      } catch (err) {
        console.error(
          `  FAILED merge ${orphan.clerkId} → ${match.email}:`,
          err instanceof Error ? err.message : err,
        );
        skipped++;
      }
      continue;
    }

    // No seeded match: just correct the email if the real address is free.
    const taken = all.some((u) => u.email === realEmail && u.id !== orphan.id);
    if (taken) {
      console.log(`  skip ${orphan.clerkId}: ${realEmail} already in use`);
      skipped++;
      continue;
    }
    await db
      .update(users)
      .set({ email: realEmail, updatedAt: new Date() })
      .where(eq(users.id, orphan.id));
    console.log(`  corrected ${orphan.clerkId}: ${orphan.email} → ${realEmail}`);
    corrected++;
  }

  console.log(
    `\nDone. merged=${merged} corrected=${corrected} skipped=${skipped}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reconcile failed:", err);
    process.exit(1);
  });
