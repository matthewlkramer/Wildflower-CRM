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
import { organizations, peopleEntityRoles, emails } from "@workspace/db/schema";
import { isNull, inArray, eq, and } from "drizzle-orm";
import { domainOf, isFreeMailDomain } from "../lib/intelDetectors";

async function main(): Promise<void> {
  const targets = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(isNull(organizations.emailDomain));

  if (targets.length === 0) {
    console.log("No organizations with a blank email_domain — nothing to do.");
    return;
  }

  console.log(`Found ${targets.length} organizations with no email_domain. Backfilling…`);

  const BATCH = 200;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH).map((r) => r.id);

    const contactEmails = await db
      .select({
        organizationId: peopleEntityRoles.organizationId,
        primaryContact: peopleEntityRoles.primaryContact,
        email: emails.email,
        isPreferred: emails.isPreferred,
      })
      .from(peopleEntityRoles)
      .innerJoin(emails, eq(emails.personId, peopleEntityRoles.personId))
      .where(
        and(
          inArray(peopleEntityRoles.organizationId, batch),
          eq(peopleEntityRoles.current, "current"),
        ),
      );

    // Group by funder
    const byOrganization = new Map<string, typeof contactEmails>();
    for (const row of contactEmails) {
      if (!row.organizationId) continue;
      const existing = byOrganization.get(row.organizationId) ?? [];
      existing.push(row);
      byOrganization.set(row.organizationId, existing);
    }

    for (const orgId of batch) {
      const rows = byOrganization.get(orgId) ?? [];
      if (rows.length === 0) {
        skipped++;
        continue;
      }

      // Only consider work-domain emails (skip gmail, icloud, comcast, etc.)
      const workDomain = (email: string | null | undefined): string | null => {
        const d = domainOf(email);
        return d && !isFreeMailDomain(d) ? d : null;
      };

      const primaryRows = rows.filter((r) => r.primaryContact);

      // 1. Active primary contact's preferred work-domain email
      const primaryPreferred =
        primaryRows.find((r) => r.isPreferred && workDomain(r.email))?.email ?? null;
      // 2. Active primary contact's any work-domain email
      const primaryAny =
        primaryRows.find((r) => workDomain(r.email))?.email ?? null;
      // 3. Most common work domain across all active contacts
      const mostCommon = (() => {
        const freq = new Map<string, number>();
        for (const r of rows) {
          const d = workDomain(r.email);
          if (d) freq.set(d, (freq.get(d) ?? 0) + 1);
        }
        if (!freq.size) return null;
        return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
      })();

      const domain =
        workDomain(primaryPreferred) ??
        workDomain(primaryAny) ??
        mostCommon;

      if (!domain) {
        skipped++;
        continue;
      }

      await db
        .update(organizations)
        .set({ emailDomain: domain })
        .where(eq(organizations.id, orgId));

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
