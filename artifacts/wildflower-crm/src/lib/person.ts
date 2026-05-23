import type { Person } from "@workspace/api-client-react";

export function personDisplayName(
  p: Pick<Person, "fullName" | "firstName" | "lastName" | "nickname" | "id">,
): string {
  if (p.fullName?.trim()) return p.fullName;
  const parts = [p.firstName, p.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (p.nickname?.trim()) return p.nickname;
  return `Person ${p.id}`;
}
