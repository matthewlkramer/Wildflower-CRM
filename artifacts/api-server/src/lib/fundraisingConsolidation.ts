import { db } from "@workspace/db";
import {
  codingFormRows,
  giftsAndPayments,
  grantLeads,
  notes,
  opportunitiesAndPledges,
  stripeStagedCharges,
  tasks,
} from "@workspace/db/schema";
import { eq, inArray, sql, type SQL } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type FundraisingRecordKind = "gift" | "opportunity";

function idArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
}

function replaceIds(
  values: string[] | null,
  survivorId: string,
  loserIds: Set<string>,
): string[] | null {
  if (!values) return null;
  return [...new Set(values.map((id) => (loserIds.has(id) ? survivorId : id)))];
}

/**
 * Re-home non-money references when fundraising records are consolidated.
 * Money children are intentionally handled by the calling transaction because
 * deduplication and combine-as-pledge have different allocation semantics.
 */
export async function repointFundraisingReferences(
  tx: Tx,
  kind: FundraisingRecordKind,
  survivorId: string,
  loserIds: string[],
): Promise<void> {
  if (loserIds.length === 0) return;
  const loserSet = new Set(loserIds);
  const ids = idArray(loserIds);

  if (kind === "gift") {
    const noteRows = await tx
      .select({ id: notes.id, values: notes.giftIds })
      .from(notes)
      .where(sql`${notes.giftIds} && ${ids}`);
    for (const row of noteRows) {
      await tx
        .update(notes)
        .set({
          giftIds: replaceIds(row.values, survivorId, loserSet),
          updatedAt: new Date(),
        })
        .where(eq(notes.id, row.id));
    }
    const taskRows = await tx
      .select({ id: tasks.id, values: tasks.giftIds })
      .from(tasks)
      .where(sql`${tasks.giftIds} && ${ids}`);
    for (const row of taskRows) {
      await tx
        .update(tasks)
        .set({
          giftIds: replaceIds(row.values, survivorId, loserSet),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, row.id));
    }
    await tx
      .update(codingFormRows)
      .set({ matchedGiftId: survivorId, updatedAt: new Date() })
      .where(inArray(codingFormRows.matchedGiftId, loserIds));
    await tx
      .update(giftsAndPayments)
      .set({ giftBeingMatchedId: survivorId, updatedAt: new Date() })
      .where(inArray(giftsAndPayments.giftBeingMatchedId, loserIds));
    await tx
      .update(giftsAndPayments)
      .set({ overpayOfGiftId: survivorId, updatedAt: new Date() })
      .where(inArray(giftsAndPayments.overpayOfGiftId, loserIds));
    await tx
      .update(stripeStagedCharges)
      .set({ refundPropagationGiftId: survivorId, updatedAt: new Date() })
      .where(inArray(stripeStagedCharges.refundPropagationGiftId, loserIds));
    return;
  }

  const noteRows = await tx
    .select({ id: notes.id, values: notes.opportunityIds })
    .from(notes)
    .where(sql`${notes.opportunityIds} && ${ids}`);
  for (const row of noteRows) {
    await tx
      .update(notes)
      .set({
        opportunityIds: replaceIds(row.values, survivorId, loserSet),
        updatedAt: new Date(),
      })
      .where(eq(notes.id, row.id));
  }
  const taskRows = await tx
    .select({ id: tasks.id, values: tasks.opportunityIds })
    .from(tasks)
    .where(sql`${tasks.opportunityIds} && ${ids}`);
  for (const row of taskRows) {
    await tx
      .update(tasks)
      .set({
        opportunityIds: replaceIds(row.values, survivorId, loserSet),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, row.id));
  }
  await tx
    .update(codingFormRows)
    .set({ matchedOpportunityId: survivorId, updatedAt: new Date() })
    .where(inArray(codingFormRows.matchedOpportunityId, loserIds));
  await tx
    .update(grantLeads)
    .set({ convertedOpportunityId: survivorId, updatedAt: new Date() })
    .where(inArray(grantLeads.convertedOpportunityId, loserIds));
  await tx
    .update(opportunitiesAndPledges)
    .set({ matchId: survivorId, updatedAt: new Date() })
    .where(inArray(opportunitiesAndPledges.matchId, loserIds));
}
