import { db } from "@workspace/db";
import { cleanupQueue } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

// Derived "Needs research" signal for detail pages. A record is flagged when an
// OPEN Cleanup Queue item with reason_code='needs_research' targets it. The
// Cleanup Queue is the single source of truth — this is never persisted on the
// record and never writable through the record's own create/update routes.
//
// Record ids are globally unique across entity tables, so matching on target_id
// alone (plus reason_code + status) is unambiguous without disambiguating
// target_type.
export async function isFlaggedForResearch(targetId: string): Promise<boolean> {
  const rows = await db
    .select({ id: cleanupQueue.id })
    .from(cleanupQueue)
    .where(
      and(
        eq(cleanupQueue.targetId, targetId),
        eq(cleanupQueue.reasonCode, "needs_research"),
        eq(cleanupQueue.status, "open"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
