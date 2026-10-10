import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conferenceAttendance,
  conferenceImportBatches,
  conferenceImportRows,
  emails,
  organizations,
  people,
  peopleEntityRoles,
} from "@workspace/db/schema";
import { newId } from "./helpers";
import {
  classifyImportRow,
  normalizePersonName,
  type DirectoryPerson,
} from "./conferenceImportDocument";
import { organizationNamesEquivalent } from "./organizationNameMatching";
import type { Request } from "express";
import { recordAudit } from "./audit";

type Executor = Pick<typeof db, "select">;
export async function importDirectory(executor: Executor) {
  const persons = await executor
    .select({
      id: people.id,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
    })
    .from(people)
    .where(isNull(people.archivedAt));
  const orgs = await executor
    .select({
      id: organizations.id,
      name: organizations.name,
      historicalNames: organizations.historicalNames,
    })
    .from(organizations)
    .where(isNull(organizations.archivedAt));
  const addresses = await executor
    .select({ personId: emails.personId, email: emails.email })
    .from(emails);
  const roles = await executor
    .select({
      personId: peopleEntityRoles.personId,
      organizationId: peopleEntityRoles.organizationId,
    })
    .from(peopleEntityRoles)
    .where(
      and(
        eq(peopleEntityRoles.current, "current"),
        eq(peopleEntityRoles.entityType, "organization"),
      ),
    );
  const emailMap = new Map<string, string[]>();
  const roleMap = new Map<string, string[]>();
  for (const e of addresses)
    if (e.personId)
      emailMap.set(e.personId, [...(emailMap.get(e.personId) ?? []), e.email]);
  for (const r of roles)
    if (r.organizationId)
      roleMap.set(r.personId, [
        ...(roleMap.get(r.personId) ?? []),
        r.organizationId,
      ]);
  const directory: DirectoryPerson[] = persons.map((p) => ({
    id: p.id,
    name: p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" "),
    emails: emailMap.get(p.id) ?? [],
    organizationIds: roleMap.get(p.id) ?? [],
  }));
  return { people: directory, organizations: orgs };
}

export function importPersonContext(
  directory: Awaited<ReturnType<typeof importDirectory>>,
  person: DirectoryPerson,
) {
  return {
    id: person.id,
    name: person.name,
    emails: person.emails,
    organizations: directory.organizations
      .filter((org) => person.organizationIds.includes(org.id))
      .map((org) => ({ id: org.id, name: org.name })),
  };
}

export type ImportReview = {
  acceptedRowIds?: string[];
  rejectedRowIds?: string[];
  personOverrides?: Record<string, string>;
  newPeople?: Record<
    string,
    {
      name: string;
      organization: string;
      title?: string;
      foundationEvidence?: string;
    }
  >;
};
export async function reviewConferenceImport(
  batchId: string,
  body: ImportReview,
  userId: string,
  req?: Request,
) {
  return db.transaction(async (tx) => {
    // Serialize import identity creation across batches, then lock the batch. A stale
    // proposal is always reconciled inside this transaction before any insert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(73481193)`);
    const [batch] = await tx
      .select()
      .from(conferenceImportBatches)
      .where(eq(conferenceImportBatches.id, batchId))
      .for("update");
    if (!batch) throw new Error("Conference import no longer exists.");
    if (batch.status === "confirmed") return;
    const rows = await tx
      .select()
      .from(conferenceImportRows)
      .where(eq(conferenceImportRows.conferenceImportBatchId, batchId))
      .orderBy(asc(conferenceImportRows.rowNumber));
    const accepted = new Set(body.acceptedRowIds ?? []);
    const rejected = new Set(body.rejectedRowIds ?? []);
    const validIds = new Set(rows.map((r) => r.id));
    const submitted = [
      ...accepted,
      ...rejected,
      ...Object.keys(body.newPeople ?? {}),
      ...Object.keys(body.personOverrides ?? {}),
    ];
    if (
      submitted.some((id) => !validIds.has(id)) ||
      [...accepted].some((id) => rejected.has(id))
    )
      throw new Error("Review contains unknown or conflicting row choices.");
    for (const row of rows) {
      if (row.disposition !== "pending") continue;
      if (rejected.has(row.id)) {
        await tx
          .update(conferenceImportRows)
          .set({
            disposition: "skip",
            reviewError: null,
            updatedAt: new Date(),
          })
          .where(eq(conferenceImportRows.id, row.id));
        continue;
      }
      if (!accepted.has(row.id)) continue;
      try {
        // Each row is a savepoint: one failure does not roll back successful rows.
        await tx.transaction(async (rowTx) => {
          const directory = await importDirectory(rowTx);
          const fresh = classifyImportRow(
            row,
            directory.people,
            directory.organizations,
          );
          let personId = body.personOverrides?.[row.id];
          const proposal = body.newPeople?.[row.id];
          let foundationEvidence: string | null = null;
          if (personId && proposal)
            throw new Error(
              "Choose an existing person or approve a proposal, not both.",
            );
          if (proposal) {
            const name = proposal.name.trim();
            const organization = proposal.organization.trim();
            if (!name || !organization)
              throw new Error(
                "Review the full name and organization before creating a person.",
              );
            const orgMatches = directory.organizations.filter((o) =>
              [o.name, ...(o.historicalNames ?? [])].some((n) =>
                organizationNamesEquivalent(n, organization),
              ),
            );
            if (orgMatches.length > 1)
              throw new Error(
                "Organization is ambiguous; resolve it in the CRM first.",
              );
            const nameMatches = directory.people.filter(
              (p) => normalizePersonName(p.name) === normalizePersonName(name),
            );
            const identity = classifyImportRow(
              {
                rawName: name,
                rawEmail: row.rawEmail,
                rawOrganization: organization,
              },
              directory.people,
              directory.organizations,
            );
            if (identity.reviewError) throw new Error(identity.reviewError);
            if (identity.matchedPersonId) personId = identity.matchedPersonId;
            else if (nameMatches.length || identity.candidatePersonIds.length)
              throw new Error(
                "A possible person already exists; select the existing person explicitly.",
              );
            if (!personId) {
              const archivedPeople = await rowTx
                .select({
                  name: people.fullName,
                  first: people.firstName,
                  last: people.lastName,
                })
                .from(people)
                .where(sql`${people.archivedAt} IS NOT NULL`);
              if (
                archivedPeople.some(
                  (p) =>
                    normalizePersonName(
                      p.name || [p.first, p.last].filter(Boolean).join(" "),
                    ) === normalizePersonName(name),
                )
              )
                throw new Error(
                  "An archived person has this name. Review or restore that identity in the CRM before creating another.",
                );
              let organizationId = orgMatches[0]?.id;
              if (!organizationId) {
                const archivedOrganizations = await rowTx
                  .select({
                    name: organizations.name,
                    historicalNames: organizations.historicalNames,
                  })
                  .from(organizations)
                  .where(sql`${organizations.archivedAt} IS NOT NULL`);
                if (
                  archivedOrganizations.some((o) =>
                    [o.name, ...(o.historicalNames ?? [])].some((n) =>
                      organizationNamesEquivalent(n, organization),
                    ),
                  )
                )
                  throw new Error(
                    "An archived organization matches this name. Review or restore it before creating another.",
                  );
                foundationEvidence =
                  proposal.foundationEvidence?.trim() ?? null;
                if (!foundationEvidence || foundationEvidence.length < 10)
                  throw new Error(
                    "New organizations require explicit evidence that this is a foundation; a name alone is insufficient.",
                  );
                organizationId = newId();
                await rowTx.insert(organizations).values({
                  id: organizationId,
                  name: organization,
                  ownerUserId: userId,
                  details: `Reviewed conference directory foundation evidence: ${foundationEvidence}. Import ${batchId}, row ${row.rowNumber}. Foundation subtype and grant-making status remain unassessed.`,
                });
              }
              personId = newId();
              // Do not invent a first/last-name split or overwrite existing contacts.
              await rowTx.insert(people).values({
                id: personId,
                fullName: name,
                ownerUserId: userId,
                details: `Approved conference directory proposal. Import ${batchId}, row ${row.rowNumber}. Original name: ${row.rawName ?? ""}.`,
              });
              await rowTx.insert(peopleEntityRoles).values({
                id: newId(),
                personId,
                entityType: "organization",
                organizationId,
                externalTitleOrRole: proposal.title?.trim() || null,
                notes: `Reviewed directory affiliation. Import ${batchId}, row ${row.rowNumber}.`,
              });
            }
          } else if (!personId) {
            if (fresh.reviewError) throw new Error(fresh.reviewError);
            if (!fresh.matchedPersonId)
              throw new Error(
                "Match changed or requires review. Select an existing person or approve a new-person proposal.",
              );
            if (
              row.matchedPersonId &&
              fresh.matchedPersonId !== row.matchedPersonId
            )
              throw new Error(
                "Match changed since preview. Choose the person explicitly.",
              );
            personId = fresh.matchedPersonId;
          }
          if (
            !personId ||
            (!directory.people.some((p) => p.id === personId) && !proposal)
          )
            throw new Error("Selected person is missing or archived.");
          await rowTx
            .insert(conferenceAttendance)
            .values({
              id: newId(),
              conferenceEventId: batch.conferenceEventId,
              personId,
              status: "possible",
              registrationListed: true,
              sourceType: "uploaded_list",
              sourceReference: `${batch.sourceFilename ?? "directory"}; import ${batchId}; row ${row.rowNumber}`,
              evidenceNote:
                "Listed in conference directory. Registration evidence only; physical attendance is unverified.",
              organizationSnapshot: row.rawOrganization,
              importedByUserId: userId,
              reviewedByUserId: userId,
              reviewedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                conferenceAttendance.conferenceEventId,
                conferenceAttendance.personId,
              ],
              set: { registrationListed: true, updatedAt: new Date() },
            });
          await rowTx
            .update(conferenceImportRows)
            .set({
              reviewedPersonId: personId,
              disposition: "accept",
              reviewError: null,
              foundationEvidence,
              category: foundationEvidence
                ? "new_foundation_person_org"
                : row.category,
              updatedAt: new Date(),
            })
            .where(eq(conferenceImportRows.id, row.id));
        });
      } catch (error) {
        // Do not expose raw SQL or database details to a reviewer.
        const message =
          error instanceof Error && !error.message.startsWith("Failed query:")
            ? error.message
            : "Could not save this row. Retry or review its identity.";
        await tx
          .update(conferenceImportRows)
          .set({ reviewError: message.slice(0, 1000), updatedAt: new Date() })
          .where(eq(conferenceImportRows.id, row.id));
      }
    }
    const pending = await tx
      .select({ id: conferenceImportRows.id })
      .from(conferenceImportRows)
      .where(
        and(
          eq(conferenceImportRows.conferenceImportBatchId, batchId),
          eq(conferenceImportRows.disposition, "pending"),
        ),
      );
    await tx
      .update(conferenceImportBatches)
      .set({
        status: pending.length ? "staged" : "confirmed",
        confirmedByUserId: pending.length ? null : userId,
        confirmedAt: pending.length ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(conferenceImportBatches.id, batchId));
    if (req)
      await recordAudit(tx, req, {
        action: "conference_attendance_reviewed",
        entityType: "conference_import",
        entityId: batchId,
        summary: "Reviewed directory registration evidence",
        metadata: {
          requestedAccepted: accepted.size,
          requestedRejected: rejected.size,
          pending: pending.length,
        },
      });
  });
}
