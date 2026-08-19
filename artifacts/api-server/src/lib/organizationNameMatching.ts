/**
 * Conservative organization-name matching for the email-intelligence path.
 *
 * This deliberately does NOT attempt fuzzy matching or remove meaningful
 * words. It only treats presentation-only differences as equivalent:
 * casing, diacritics, punctuation, repeated whitespace, and one leading
 * "the". That makes "The College Board" resolve to "College Board" while
 * keeping "College Board Foundation" distinct.
 */
export function canonicalOrganizationName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    // Apostrophes are commonly optional within a word (O'Reilly/OReilly).
    .replace(/['’]/g, "")
    // Other punctuation is a word boundary, not a word to discard.
    .replace(/\p{P}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

export function organizationNamesEquivalent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  const canonicalLeft = canonicalOrganizationName(left);
  const canonicalRight = canonicalOrganizationName(right);
  return canonicalLeft.length > 0 && canonicalLeft === canonicalRight;
}
