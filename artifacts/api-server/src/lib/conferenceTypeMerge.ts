import {
  conferenceAttendance,
  conferenceAttendanceSuggestions,
  conferenceEvents,
  conferenceImportBatches,
  conferenceImportRows,
  conferenceResearchRequests,
  conferenceSpeakerProposals,
} from "@workspace/db/schema";
import { asc, eq, inArray } from "drizzle-orm";

type MergeTx = Parameters<Parameters<typeof import("@workspace/db").db.transaction>[0]>[0];

export interface EventResolution {
  sourceEventId: string;
  targetEventId: string;
  strategy?: "preserve_all_history";
}

export class ConferenceMergeConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConferenceMergeConflict";
  }
}

export class ConferenceMergeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConferenceMergeValidationError";
  }
}

const statusWeight: Record<string, number> = { possible: 1, likely: 2, confirmed: 3 };
const reviewWeight: Record<string, number> = { pending: 0, accepted: 1, dismissed: 1, added: 2, ignored: 2 };

function appendHistory(current: string | null | undefined, label: string, value: unknown): string {
  const history = `${label}: ${JSON.stringify(value)}`;
  return [current?.trim(), history].filter(Boolean).join("\n\n");
}

function uniqueKey(...values: unknown[]): string {
  return JSON.stringify(values);
}

export function chooseAttendanceWinner<T extends { status: string; conferenceEventId: string; id: string }>(
  rows: readonly T[],
  targetEventId: string,
): T {
  return [...rows].sort((a, b) =>
    (statusWeight[b.status] ?? 0) - (statusWeight[a.status] ?? 0)
    || Number(b.conferenceEventId === targetEventId) - Number(a.conferenceEventId === targetEventId)
    || a.id.localeCompare(b.id))[0];
}

export function sourceWindowKey(original: string | null, sourceEventId: string, suffix = 0): string | null {
  if (original === null) return null;
  return `${original}:merged-from:${sourceEventId}${suffix ? `:${suffix}` : ""}`;
}

function assertSameImportRow(
  a: typeof conferenceImportRows.$inferSelect,
  b: typeof conferenceImportRows.$inferSelect,
): void {
    if (a.rawName !== b.rawName || a.rawEmail !== b.rawEmail || a.rawOrganization !== b.rawOrganization || a.rawTitle !== b.rawTitle || JSON.stringify(a.rawCells) !== JSON.stringify(b.rawCells)) {
    throw new ConferenceMergeConflict(
      `Import rows ${a.id} and ${b.id} have different source data at row ${a.rowNumber}; resolve this import collision manually.`,
    );
  }
  const acceptedPeople = new Set(
    [a, b]
      .filter((row) => row.disposition === "accept")
      .map((row) => row.reviewedPersonId ?? row.matchedPersonId)
      .filter((id): id is string => !!id),
  );
  if (acceptedPeople.size > 1 || (a.disposition === "accept" && b.disposition === "skip") ||
    (a.disposition === "skip" && b.disposition === "accept")) {
    throw new ConferenceMergeConflict(
      `Import rows ${a.id} and ${b.id} have conflicting review decisions; resolve this import collision manually.`,
    );
  }
}

async function consolidateAttendance(tx: MergeTx, sourceEventId: string, targetEventId: string): Promise<void> {
  const rows = await tx.select().from(conferenceAttendance)
    .where(inArray(conferenceAttendance.conferenceEventId, [sourceEventId, targetEventId])).for("update");
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.personId) ?? [];
    group.push(row);
    groups.set(row.personId, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const winner = chooseAttendanceWinner(group, targetEventId);
    const duplicates = group.filter((row) => row.id !== winner.id);
    const strongest = [...group].sort((a, b) =>
      (statusWeight[b.status] ?? 0) - (statusWeight[a.status] ?? 0))[0];
    const reviewed = [...group].filter((row) => row.reviewedAt)
      .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0))[0];
    await tx.update(conferenceAttendance).set({
      status: strongest.status,
      registrationListed: group.some((row) => row.registrationListed),
      role: winner.role === "Attendee" ? (group.find((row) => row.role !== "Attendee")?.role ?? winner.role) : winner.role,
      sourceReference: winner.sourceReference ?? group.find((row) => row.sourceReference)?.sourceReference ?? null,
      evidenceNote: duplicates.reduce((note, row) => appendHistory(note, "Merged attendance evidence", {
        id: row.id, status: row.status, role: row.role, sourceType: row.sourceType,
        sourceReference: row.sourceReference, evidenceNote: row.evidenceNote,
        organizationSnapshot: row.organizationSnapshot, matchedByUserId: row.matchedByUserId,
        importedByUserId: row.importedByUserId, reviewedByUserId: row.reviewedByUserId,
        reviewedAt: row.reviewedAt, createdAt: row.createdAt,
      }), winner.evidenceNote),
      organizationSnapshot: winner.organizationSnapshot ?? group.find((row) => row.organizationSnapshot)?.organizationSnapshot ?? null,
      matchedByUserId: winner.matchedByUserId ?? group.find((row) => row.matchedByUserId)?.matchedByUserId ?? null,
      importedByUserId: winner.importedByUserId ?? group.find((row) => row.importedByUserId)?.importedByUserId ?? null,
      reviewedByUserId: reviewed?.reviewedByUserId ?? winner.reviewedByUserId,
      reviewedAt: reviewed?.reviewedAt ?? winner.reviewedAt,
      updatedAt: new Date(),
    }).where(eq(conferenceAttendance.id, winner.id));
    await tx.delete(conferenceAttendance).where(inArray(conferenceAttendance.id, duplicates.map((row) => row.id)));
    if (winner.conferenceEventId !== targetEventId) {
      await tx.update(conferenceAttendance).set({ conferenceEventId: targetEventId }).where(eq(conferenceAttendance.id, winner.id));
    }
  }
  await tx.update(conferenceAttendance).set({ conferenceEventId: targetEventId, updatedAt: new Date() })
    .where(eq(conferenceAttendance.conferenceEventId, sourceEventId));
}

async function consolidateSuggestions(tx: MergeTx, sourceEventId: string, targetEventId: string): Promise<void> {
  const rows = await tx.select().from(conferenceAttendanceSuggestions)
    .where(inArray(conferenceAttendanceSuggestions.conferenceEventId, [sourceEventId, targetEventId])).for("update");
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = uniqueKey(row.personId, row.emailMessageId);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const reviewedOutcomes = new Set(group.filter((row) => row.status !== "pending").map((row) => row.status));
    if (reviewedOutcomes.size > 1) {
      throw new ConferenceMergeConflict("Duplicate email suggestions have conflicting reviewed outcomes; resolve them manually before merging.");
    }
    const [winner, ...duplicates] = [...group].sort((a, b) =>
      (reviewWeight[b.status] ?? 0) - (reviewWeight[a.status] ?? 0)
      || Number(b.conferenceEventId === targetEventId) - Number(a.conferenceEventId === targetEventId)
      || a.id.localeCompare(b.id));
    const reviewed = [...group].filter((row) => row.reviewedAt)
      .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0))[0];
    await tx.update(conferenceAttendanceSuggestions).set({
      evidenceNote: duplicates.reduce((note, row) => appendHistory(note, "Merged suggestion history", {
        id: row.id, status: row.status, confidence: row.confidence, evidenceNote: row.evidenceNote,
        reviewedByUserId: row.reviewedByUserId, reviewedAt: row.reviewedAt,
      }), winner.evidenceNote),
      confidence: group.some((row) => row.confidence === "high") ? "high"
        : group.some((row) => row.confidence === "medium") ? "medium" : "low",
      reviewedByUserId: reviewed?.reviewedByUserId ?? winner.reviewedByUserId,
      reviewedAt: reviewed?.reviewedAt ?? winner.reviewedAt,
      updatedAt: new Date(),
    }).where(eq(conferenceAttendanceSuggestions.id, winner.id));
    await tx.delete(conferenceAttendanceSuggestions).where(inArray(conferenceAttendanceSuggestions.id, duplicates.map((row) => row.id)));
    if (winner.conferenceEventId !== targetEventId) {
      await tx.update(conferenceAttendanceSuggestions).set({ conferenceEventId: targetEventId }).where(eq(conferenceAttendanceSuggestions.id, winner.id));
    }
  }
  await tx.update(conferenceAttendanceSuggestions).set({ conferenceEventId: targetEventId, updatedAt: new Date() })
    .where(eq(conferenceAttendanceSuggestions.conferenceEventId, sourceEventId));
}

async function consolidateImports(tx: MergeTx, sourceEventId: string, targetEventId: string): Promise<unknown[]> {
  const history: unknown[] = [];
  const batches = await tx.select().from(conferenceImportBatches)
    .where(inArray(conferenceImportBatches.conferenceEventId, [sourceEventId, targetEventId])).for("update");
  const byHash = new Map<string, typeof batches>();
  for (const batch of batches) {
    const group = byHash.get(batch.sourceHash) ?? [];
    group.push(batch);
    byHash.set(batch.sourceHash, group);
  }
  for (const group of byHash.values()) {
    if (group.length === 1) {
      if (group[0].conferenceEventId === sourceEventId) {
        await tx.update(conferenceImportBatches).set({ conferenceEventId: targetEventId, updatedAt: new Date() })
          .where(eq(conferenceImportBatches.id, group[0].id));
      }
      continue;
    }
    const winner = group.find((batch) => batch.conferenceEventId === targetEventId) ?? group[0];
    const duplicates = group.filter((batch) => batch.id !== winner.id);
    history.push(...duplicates);
    const allRows = await tx.select().from(conferenceImportRows)
      .where(inArray(conferenceImportRows.conferenceImportBatchId, group.map((batch) => batch.id))).for("update");
    const rowsByNumber = new Map<number, typeof allRows>();
    for (const row of allRows) {
      const sameNumber = rowsByNumber.get(row.rowNumber) ?? [];
      sameNumber.push(row);
      rowsByNumber.set(row.rowNumber, sameNumber);
    }
    for (const sameNumber of rowsByNumber.values()) {
      if (sameNumber.length < 2) continue;
      const [rowWinner, ...rowDuplicates] = [...sameNumber].sort((a, b) =>
        Number(b.disposition !== "pending") - Number(a.disposition !== "pending")
        || Number(b.conferenceImportBatchId === winner.id) - Number(a.conferenceImportBatchId === winner.id)
        || a.id.localeCompare(b.id));
      for (const duplicate of rowDuplicates) assertSameImportRow(rowWinner, duplicate);
      const accepted = sameNumber.find((row) => row.disposition === "accept");
      const skipped = sameNumber.find((row) => row.disposition === "skip");
      if (accepted && skipped) {
        throw new ConferenceMergeConflict(`Import row ${rowWinner.rowNumber} has conflicting accept/skip reviews; resolve it manually.`);
      }
      const acceptedPeople = new Set(sameNumber.map((row) =>
        row.disposition === "accept" ? row.reviewedPersonId ?? row.matchedPersonId : null).filter(Boolean));
      if (acceptedPeople.size > 1) {
        throw new ConferenceMergeConflict(`Import row ${rowWinner.rowNumber} has conflicting reviewed people; resolve it manually.`);
      }
      await tx.delete(conferenceImportRows).where(inArray(conferenceImportRows.id, rowDuplicates.map((row) => row.id)));
      await tx.update(conferenceImportRows).set({
        conferenceImportBatchId: winner.id,
        matchEvidence: rowDuplicates.reduce((evidence, row) => appendHistory(evidence, "Merged import-row history", {
          id: row.id, matchStatus: row.matchStatus, matchedPersonId: row.matchedPersonId,
          matchEvidence: row.matchEvidence, reviewedPersonId: row.reviewedPersonId,
          disposition: row.disposition, createdAt: row.createdAt,
        }), rowWinner.matchEvidence),
        matchStatus: sameNumber.some((row) => row.matchStatus === "exact") ? "exact"
          : sameNumber.some((row) => row.matchStatus === "ambiguous") ? "ambiguous" : "unmatched",
        matchedPersonId: rowWinner.matchedPersonId ?? sameNumber.find((row) => row.matchedPersonId)?.matchedPersonId ?? null,
        reviewedPersonId: rowWinner.reviewedPersonId ?? sameNumber.find((row) => row.reviewedPersonId)?.reviewedPersonId ?? null,
        disposition: accepted ? "accept" : skipped ? "skip" : "pending",
        updatedAt: new Date(),
      }).where(eq(conferenceImportRows.id, rowWinner.id));
    }
    await tx.update(conferenceImportRows).set({ conferenceImportBatchId: winner.id, updatedAt: new Date() })
      .where(inArray(conferenceImportRows.conferenceImportBatchId, duplicates.map((batch) => batch.id)));
    const confirmed = group.find((batch) => batch.status === "confirmed");
    await tx.update(conferenceImportBatches).set({
      conferenceEventId: targetEventId,
      status: confirmed ? "confirmed" : "staged",
      sourceFilename: winner.sourceFilename ?? group.find((batch) => batch.sourceFilename)?.sourceFilename ?? null,
      createdByUserId: winner.createdByUserId ?? group.find((batch) => batch.createdByUserId)?.createdByUserId ?? null,
      confirmedByUserId: confirmed?.confirmedByUserId ?? winner.confirmedByUserId,
      confirmedAt: confirmed?.confirmedAt ?? winner.confirmedAt,
      updatedAt: new Date(),
    }).where(eq(conferenceImportBatches.id, winner.id));
    await tx.delete(conferenceImportBatches).where(inArray(conferenceImportBatches.id, duplicates.map((batch) => batch.id)));
  }
  return history;
}

async function moveResearchRuns(tx: MergeTx, sourceEventId: string, targetEventId: string): Promise<void> {
  const sourceRuns = await tx.select().from(conferenceResearchRequests)
    .where(eq(conferenceResearchRequests.conferenceEventId, sourceEventId)).for("update");
  const targetRuns = await tx.select().from(conferenceResearchRequests)
    .where(eq(conferenceResearchRequests.conferenceEventId, targetEventId)).for("update");
  const occupied = new Set(targetRuns
    .filter((run) => run.windowKey !== null)
    .map((run) => uniqueKey(run.kind, run.windowKey)));
  for (const run of sourceRuns) {
    let windowKey = run.windowKey;
    if (windowKey !== null && occupied.has(uniqueKey(run.kind, windowKey))) {
      let suffix = 0;
      do {
        windowKey = sourceWindowKey(run.windowKey, sourceEventId, suffix++);
      } while (occupied.has(uniqueKey(run.kind, windowKey)));
      occupied.add(uniqueKey(run.kind, windowKey));
    } else if (windowKey !== null) {
      occupied.add(uniqueKey(run.kind, windowKey));
    }
    await tx.update(conferenceResearchRequests).set({ conferenceEventId: targetEventId, windowKey, updatedAt: new Date() })
      .where(eq(conferenceResearchRequests.id, run.id));
  }
}

async function consolidateSpeakerProposals(tx: MergeTx, sourceEventId: string, targetEventId: string): Promise<void> {
  const proposals = await tx.select().from(conferenceSpeakerProposals)
    .where(inArray(conferenceSpeakerProposals.conferenceEventId, [sourceEventId, targetEventId])).for("update");
  const byFingerprint = new Map<string, typeof proposals>();
  for (const proposal of proposals) {
    const group = byFingerprint.get(proposal.speakerFingerprint) ?? [];
    group.push(proposal);
    byFingerprint.set(proposal.speakerFingerprint, group);
  }
  for (const group of byFingerprint.values()) {
    if (group.length < 2) continue;
    const reviewedOutcomes = new Set(group.filter((proposal) => proposal.status !== "pending").map((proposal) => proposal.status));
    if (reviewedOutcomes.size > 1) {
      throw new ConferenceMergeConflict("Duplicate speaker proposals have conflicting review outcomes; resolve them manually before merging.");
    }
    const [winner, ...duplicates] = [...group].sort((a, b) =>
      (reviewWeight[b.status] ?? 0) - (reviewWeight[a.status] ?? 0)
      || Number(b.conferenceEventId === targetEventId) - Number(a.conferenceEventId === targetEventId)
      || a.id.localeCompare(b.id));
    const reviewed = [...group].filter((proposal) => proposal.reviewedAt)
      .sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0))[0];
    await tx.update(conferenceSpeakerProposals).set({
      sessionEvidence: duplicates.reduce((evidence, proposal) =>
        appendHistory(evidence, "Merged speaker proposal history", proposal), winner.sessionEvidence),
      candidatePersonIds: [...new Set(group.flatMap((proposal) => proposal.candidatePersonIds))],
      title: winner.title ?? group.find((proposal) => proposal.title)?.title ?? null,
      organizationName: winner.organizationName ?? group.find((proposal) => proposal.organizationName)?.organizationName ?? null,
      bio: winner.bio ?? group.find((proposal) => proposal.bio)?.bio ?? null,
      profileUrl: winner.profileUrl ?? group.find((proposal) => proposal.profileUrl)?.profileUrl ?? null,
      sourceUrl: winner.sourceUrl ?? group.find((proposal) => proposal.sourceUrl)?.sourceUrl ?? null,
      matchedPersonId: winner.matchedPersonId ?? group.find((proposal) => proposal.matchedPersonId)?.matchedPersonId ?? null,
      matchedOrganizationId: winner.matchedOrganizationId ?? group.find((proposal) => proposal.matchedOrganizationId)?.matchedOrganizationId ?? null,
      addedPersonId: winner.addedPersonId ?? group.find((proposal) => proposal.addedPersonId)?.addedPersonId ?? null,
      reviewedByUserId: reviewed?.reviewedByUserId ?? winner.reviewedByUserId,
      reviewedAt: reviewed?.reviewedAt ?? winner.reviewedAt,
      updatedAt: new Date(),
    }).where(eq(conferenceSpeakerProposals.id, winner.id));
    await tx.delete(conferenceSpeakerProposals).where(inArray(conferenceSpeakerProposals.id, duplicates.map((proposal) => proposal.id)));
    if (winner.conferenceEventId !== targetEventId) {
      await tx.update(conferenceSpeakerProposals).set({ conferenceEventId: targetEventId }).where(eq(conferenceSpeakerProposals.id, winner.id));
    }
  }
  await tx.update(conferenceSpeakerProposals).set({ conferenceEventId: targetEventId, updatedAt: new Date() })
    .where(eq(conferenceSpeakerProposals.conferenceEventId, sourceEventId));
}

async function consolidateEventChildren(tx: MergeTx, sourceEventId: string, targetEventId: string): Promise<unknown[]> {
  await consolidateAttendance(tx, sourceEventId, targetEventId);
  await consolidateSuggestions(tx, sourceEventId, targetEventId);
  const importBatchHistory = await consolidateImports(tx, sourceEventId, targetEventId);
  await moveResearchRuns(tx, sourceEventId, targetEventId);
  await consolidateSpeakerProposals(tx, sourceEventId, targetEventId);
  return importBatchHistory;
}

export async function mergeConferenceTypeEvents(
  tx: MergeTx,
  sourceTypeId: string,
  targetTypeId: string,
  resolutions: readonly EventResolution[],
): Promise<{ reassignedEventCount: number; consolidatedEventIds: string[]; importBatchHistory: unknown[] }> {
  const events = await tx.select().from(conferenceEvents)
    .where(inArray(conferenceEvents.conferenceTypeId, [sourceTypeId, targetTypeId]))
    .orderBy(asc(conferenceEvents.id)).for("update");
  const sourceEvents = events.filter((event) => event.conferenceTypeId === sourceTypeId);
  const targetByYear = new Map(events.filter((event) => event.conferenceTypeId === targetTypeId)
    .map((event) => [event.year, event]));
  const resolutionBySource = new Map<string, EventResolution>();
  for (const resolution of resolutions) {
    if (resolutionBySource.has(resolution.sourceEventId)) {
      throw new ConferenceMergeValidationError(`Duplicate event resolution for source event ${resolution.sourceEventId}.`);
    }
    resolutionBySource.set(resolution.sourceEventId, resolution);
  }
  if (resolutions.some((resolution) => !sourceEvents.some((event) => event.id === resolution.sourceEventId))) {
    throw new ConferenceMergeValidationError("An event resolution references an event that does not belong to the source type.");
  }
  const collisions = sourceEvents.filter((event) => targetByYear.has(event.year));
  const importBatchHistory: unknown[] = [];
  for (const source of collisions) {
    const target = targetByYear.get(source.year)!;
    const resolution = resolutionBySource.get(source.id);
    if (!resolution || resolution.targetEventId !== target.id || resolution.strategy !== "preserve_all_history") {
      throw new ConferenceMergeConflict(
        `Both conference types have an event for ${source.year}; explicitly map the source event to ${target.id} with preserve_all_history.`,
      );
    }
  }
  for (const resolution of resolutions) {
    const source = sourceEvents.find((event) => event.id === resolution.sourceEventId);
    if (!source || targetByYear.get(source.year)?.id !== resolution.targetEventId) {
      throw new ConferenceMergeValidationError("Event resolutions must map same-year source and target events.");
    }
  }

  for (const source of sourceEvents) {
    const target = targetByYear.get(source.year);
    if (!target) {
      await tx.update(conferenceEvents).set({ conferenceTypeId: targetTypeId, updatedAt: new Date() })
        .where(eq(conferenceEvents.id, source.id));
      continue;
    }
    importBatchHistory.push(...await consolidateEventChildren(tx, source.id, target.id));
    const history = appendHistory(target.notes, "Merged conference event", {
      ...source,
      sourceEventId: source.id,
      targetEventId: target.id,
    });
    await tx.update(conferenceEvents).set({ notes: history, updatedAt: new Date() }).where(eq(conferenceEvents.id, target.id));
    await tx.delete(conferenceEvents).where(eq(conferenceEvents.id, source.id));
  }
  return {
    reassignedEventCount: sourceEvents.length,
    consolidatedEventIds: collisions.map((event) => event.id),
    importBatchHistory,
  };
}
