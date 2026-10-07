export type MeetingLinkKind = "person" | "organization" | "household";
export type MeetingLink = { kind: MeetingLinkKind; id: string };

export function uniqueMeetingLinks(links: MeetingLink[]): MeetingLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.kind}:${link.id}`;
    if (!link.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function meetingLinksFromIds(value: {
  personIds?: string[] | null;
  organizationIds?: string[] | null;
  householdIds?: string[] | null;
}): MeetingLink[] {
  return uniqueMeetingLinks([
    ...(value.personIds ?? []).map((id) => ({ kind: "person" as const, id })),
    ...(value.organizationIds ?? []).map((id) => ({
      kind: "organization" as const,
      id,
    })),
    ...(value.householdIds ?? []).map((id) => ({
      kind: "household" as const,
      id,
    })),
  ]);
}

export function meetingLinkIds(links: MeetingLink[]) {
  const unique = uniqueMeetingLinks(links);
  return {
    personIds: unique
      .filter((link) => link.kind === "person")
      .map((link) => link.id),
    organizationIds: unique
      .filter((link) => link.kind === "organization")
      .map((link) => link.id),
    householdIds: unique
      .filter((link) => link.kind === "household")
      .map((link) => link.id),
  };
}
