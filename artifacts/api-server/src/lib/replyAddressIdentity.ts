/** A display name is supporting evidence only; the caller must also establish
 * a unique CRM person and an earlier outbound message in the same thread. */
export function replySenderName(fromHeader: string): string | null {
  const match = fromHeader.match(/^\s*"?([^<>]+?)"?\s*<[^<>]+>\s*$/);
  if (!match) return null;
  const name = match[1].replace(/^"|"$/g, "").trim().replace(/\s+/g, " ");
  return name.split(" ").length >= 2 && !name.includes("@") ? name : null;
}
