/**
 * One-shot backfill: populate email_domain on funders that currently have
 * none, derived from the emails of actively-linked contacts.
 *
 * Priority per funder:
 *   1. Active primary contact's preferred email domain
 *   2. Active primary contact's any email domain
 *   3. Most common domain among all active contacts' emails
 *
 * Only touches rows where email_domain IS NULL. Safe to re-run (idempotent).
 *
 * Run with: pnpm --filter @workspace/api-server run backfill:email-domains
 */
import { db } from "@workspace/db";
import { funders, peopleEntityRoles, emails } from "@workspace/db/schema";
import { isNull, inArray, eq, and } from "drizzle-orm";

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.length > 0 ? d : null;
}

async function main(): Promise<void> {
  const targets = await db
    .select({ id: funders.id })
    .from(funders)
    .where(isNull(funders.emailDomain));

  if (targets.length === 0) {
    console.log("No funders with a blank email_domain — nothing to do.");
    return;
  }

  console.log(`Found ${targets.length} funders with no email_domain. Backfilling…`);

  const BATCH = 200;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH).map((r) => r.id);

    const contactEmails = await db
      .select({
        funderId: peopleEntityRoles.funderId,
        primaryContact: peopleEntityRoles.primaryContact,
        email: emails.email,
        isPreferred: emails.isPreferred,
      })
      .from(peopleEntityRoles)
      .innerJoin(emails, eq(emails.personId, peopleEntityRoles.personId))
      .where(
        and(
          inArray(peopleEntityRoles.funderId, batch),
          eq(peopleEntityRoles.current, "current"),
        ),
      );

    // Group by funder
    const byFunder = new Map<string, typeof contactEmails>();
    for (const row of contactEmails) {
      if (!row.funderId) continue;
      const existing = byFunder.get(row.funderId) ?? [];
      existing.push(row);
      byFunder.set(row.funderId, existing);
    }

    for (const funderId of batch) {
      const rows = byFunder.get(funderId) ?? [];
      if (rows.length === 0) {
        skipped++;
        continue;
      }

      const primaryRows = rows.filter((r) => r.primaryContact);

      // 1. Active primary contact's preferred email
      const primaryPreferred =
        primaryRows.find((r) => r.isPreferred)?.email ?? null;
      // 2. Active primary contact's any email
      const primaryAny = primaryRows[0]?.email ?? null;
      // 3. Most common domain among all active contacts
      const mostCommon = (() => {
        const freq = new Map<string, number>();
        for (const r of rows) {
          const d = domainOf(r.email);
          if (d) freq.set(d, (freq.get(d) ?? 0) + 1);
        }
        if (!freq.size) return null;
        return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
      })();

      const domain =
        domainOf(primaryPreferred ?? "") ??
        domainOf(primaryAny ?? "") ??
        mostCommon;

      if (!domain) {
        skipped++;
        continue;
      }

      await db
        .update(funders)
        .set({ emailDomain: domain })
        .where(eq(funders.id, funderId));

      updated++;
    }

    process.stdout.write(".");
  }

  console.log(`\nDone. Updated ${updated}, skipped ${skipped} (no active contacts with emails).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
