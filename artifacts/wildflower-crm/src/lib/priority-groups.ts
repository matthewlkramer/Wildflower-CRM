export type OrganizationPriority = {
  id: string;
  name: string;
  href: string;
  kind: "Organization";
  lastContacted: string | null;
};

export type PersonPriority = {
  id: string;
  name: string;
  href: string;
  kind: "Individual";
  lastContacted: string | null;
  activeOrganizationIds: readonly string[];
};

export type PriorityRecord = OrganizationPriority | PersonPriority;

export type PriorityGroup = {
  key: string;
  organization: OrganizationPriority | null;
  people: PersonPriority[];
  oldestContact: string | null;
};

function compareContactDates(
  a: { lastContacted: string | null; name: string },
  b: { lastContacted: string | null; name: string },
) {
  if (a.lastContacted !== b.lastContacted) {
    if (!a.lastContacted) return -1;
    if (!b.lastContacted) return 1;
    return a.lastContacted.localeCompare(b.lastContacted);
  }
  return a.name.localeCompare(b.name);
}

function oldestContact(records: readonly PriorityRecord[]): string | null {
  const sorted = [...records].sort(compareContactDates);
  return sorted[0]?.lastContacted ?? null;
}

/**
 * Combines a top-priority person with their top-priority current organization.
 * A person linked to several priority organizations is placed with the first
 * matching affiliation returned by the API so the person never appears twice.
 */
export function groupPriorityRecords(
  organizations: readonly OrganizationPriority[],
  people: readonly PersonPriority[],
): PriorityGroup[] {
  const byOrganizationId = new Map<string, PriorityGroup>();
  const groups: PriorityGroup[] = organizations.map((organization) => {
    const group: PriorityGroup = {
      key: `organization-${organization.id}`,
      organization,
      people: [],
      oldestContact: organization.lastContacted,
    };
    byOrganizationId.set(organization.id, group);
    return group;
  });

  for (const person of people) {
    const relatedGroup = person.activeOrganizationIds
      .map((id) => byOrganizationId.get(id))
      .find((group): group is PriorityGroup => Boolean(group));

    if (relatedGroup) {
      relatedGroup.people.push(person);
      relatedGroup.oldestContact = oldestContact([
        relatedGroup.organization!,
        ...relatedGroup.people,
      ]);
    } else {
      groups.push({
        key: `person-${person.id}`,
        organization: null,
        people: [person],
        oldestContact: person.lastContacted,
      });
    }
  }

  for (const group of groups) {
    group.people.sort(compareContactDates);
  }

  return groups.sort((a, b) => {
    const aName = a.organization?.name ?? a.people[0]?.name ?? "";
    const bName = b.organization?.name ?? b.people[0]?.name ?? "";
    return compareContactDates(
      { lastContacted: a.oldestContact, name: aName },
      { lastContacted: b.oldestContact, name: bName },
    );
  });
}
