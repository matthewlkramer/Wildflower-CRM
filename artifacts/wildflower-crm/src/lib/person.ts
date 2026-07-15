import type { Person } from "@workspace/api-client-react";

// Canonical display-name chain, mirrored by the server's personDisplayNameSql
// (and the people list's default sort key):
//   preferred(nickname)+last → full_name → first+last → "Person <id>"
// The nickname field holds the person's *preferred* name (the name they
// actually go by, e.g. "Tommy" for "Thomas Barrett III"), so when set it
// replaces the first name in the display.
export function personDisplayName(
  p: Pick<Person, "fullName" | "firstName" | "lastName" | "nickname" | "id">,
): string {
  if (p.nickname?.trim()) {
    return [p.nickname.trim(), p.lastName].filter(Boolean).join(" ");
  }
  if (p.fullName?.trim()) return p.fullName;
  const parts = [p.firstName, p.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  return `Person ${p.id}`;
}
