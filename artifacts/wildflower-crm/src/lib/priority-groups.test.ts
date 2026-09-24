import { describe, expect, it } from "vitest";
import {
  groupPriorityRecords,
  type OrganizationPriority,
  type PersonPriority,
} from "./priority-groups";

const organization: OrganizationPriority = {
  id: "org-csgf",
  name: "Charter School Growth Fund",
  href: "/organizations/org-csgf",
  kind: "Organization",
  lastContacted: "2026-09-01",
};

function person(
  id: string,
  name: string,
  activeOrganizationIds: readonly string[],
  lastContacted: string | null = "2026-09-10",
): PersonPriority {
  return {
    id,
    name,
    href: `/individuals/${id}`,
    kind: "Individual",
    lastContacted,
    activeOrganizationIds,
  };
}

describe("priority grouping", () => {
  it("puts a person and their current priority organization in one group", () => {
    const groups = groupPriorityRecords(
      [organization],
      [person("kevin", "Kevin Hall", [organization.id])],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.organization?.id).toBe(organization.id);
    expect(groups[0]?.people.map((record) => record.id)).toEqual(["kevin"]);
  });

  it("keeps people standalone when their current organization is not a priority", () => {
    const groups = groupPriorityRecords(
      [organization],
      [person("other", "Other Person", ["org-not-priority"])],
    );

    expect(groups).toHaveLength(2);
    expect(
      groups.find((group) => group.key === "person-other")?.people,
    ).toHaveLength(1);
  });

  it("does not duplicate a person linked to multiple priority organizations", () => {
    const secondOrganization: OrganizationPriority = {
      ...organization,
      id: "org-second",
      name: "Second Organization",
    };
    const groups = groupPriorityRecords(
      [organization, secondOrganization],
      [
        person("multi", "Multi Person", [
          organization.id,
          secondOrganization.id,
        ]),
      ],
    );

    expect(groups.flatMap((group) => group.people)).toHaveLength(1);
  });

  it("orders groups by the oldest contact across grouped records", () => {
    const groups = groupPriorityRecords(
      [organization],
      [
        person("kevin", "Kevin Hall", [organization.id], null),
        person("standalone", "Standalone", [], "2026-01-01"),
      ],
    );

    expect(groups[0]?.key).toBe(`organization-${organization.id}`);
  });
});
