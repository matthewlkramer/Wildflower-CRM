import { db } from "@workspace/db";
import { wildflowerUpdates } from "@workspace/db/schema";

/**
 * Cached accessor for the single shared "Wildflower updates" note.
 *
 * The note is injected into the AI prompts that generate donor next-step
 * task suggestions (proposeTask) and email-intelligence action proposals
 * (proposeActions). Those run frequently, so we cache the text in-process
 * with a short TTL and bust it explicitly when the note is saved (the PUT
 * route) or applied (a note_revision proposal accept), mirroring the
 * internal-email-domains cache pattern.
 *
 * Returns "" when no note row exists yet (never throws into the AI path).
 */
let cached: { content: string; at: number } | null = null;
const TTL_MS = 60_000;

export async function loadWildflowerUpdateNote(): Promise<string> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.content;
  try {
    const row = await db
      .select({ content: wildflowerUpdates.content })
      .from(wildflowerUpdates)
      .then((r) => r[0]);
    const content = (row?.content ?? "").trim();
    cached = { content, at: Date.now() };
    return content;
  } catch {
    // Never let a transient DB hiccup break the AI pipeline — fall back to
    // an empty note (no Wildflower-updates context this run).
    return cached?.content ?? "";
  }
}

export function invalidateWildflowerUpdateNoteCache(): void {
  cached = null;
}
