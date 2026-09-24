import { describe, expect, it } from "vitest";
import { EntityType } from "@workspace/api-client-react";
import { ORGANIZATION_TYPE_GROUPS } from "./organization-type-groups";

describe("organization type groups", () => {
  it("places every organization type in exactly one submenu", () => {
    const groupedValues = ORGANIZATION_TYPE_GROUPS.flatMap((group) =>
      group.options.map((option) => option.value),
    );

    expect(new Set(groupedValues).size).toBe(groupedValues.length);
    expect([...groupedValues].sort()).toEqual(
      [...Object.values(EntityType)].sort(),
    );
  });

  it("keeps foundation types together", () => {
    const foundation = ORGANIZATION_TYPE_GROUPS.find(
      (group) => group.label === "Foundation",
    );

    expect(foundation?.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([
        EntityType.family_foundation,
        EntityType.institutional_foundation,
        EntityType.corporate_foundation,
        EntityType.community_foundation,
        EntityType.bank_foundation,
      ]),
    );
  });
});
