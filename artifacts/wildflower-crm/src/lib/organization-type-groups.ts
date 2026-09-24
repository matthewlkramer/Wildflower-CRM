import { EntityType } from "@workspace/api-client-react";
import type {
  InlineSelectGroup,
  InlineSelectOption,
} from "@/components/inline-edit";
import { formatEnum } from "@/lib/format";

function options(
  values: readonly EntityType[],
): ReadonlyArray<InlineSelectOption<EntityType>> {
  return values.map((value) => ({ value, label: formatEnum(value) }));
}

/**
 * Keeps the long organization-type taxonomy navigable while preserving the
 * existing enum values written to the API. Every EntityType appears exactly
 * once; the companion test guards that invariant as the taxonomy evolves.
 */
export const ORGANIZATION_TYPE_GROUPS: ReadonlyArray<
  InlineSelectGroup<EntityType>
> = [
  {
    label: "Foundation",
    options: options([
      EntityType.family_foundation,
      EntityType.institutional_foundation,
      EntityType.corporate_foundation,
      EntityType.community_foundation,
      EntityType.bank_foundation,
      EntityType.family_office_trust,
    ]),
  },
  {
    label: "Education",
    options: options([
      EntityType.school,
      EntityType.school_network,
      EntityType.school_district,
      EntityType.authorizer,
      EntityType.higher_ed,
      EntityType.education_vendor,
      EntityType.education_forprofit,
    ]),
  },
  {
    label: "Philanthropy & intermediaries",
    options: options([
      EntityType.intermediary,
      EntityType.philanthropic_advisor,
      EntityType.daf_platform,
      EntityType.capital_provider,
      EntityType.cdfi,
      EntityType.platform,
    ]),
  },
  {
    label: "Business & finance",
    options: options([
      EntityType.corporation,
      EntityType.investor,
      EntityType.real_estate,
      EntityType.small_business_consulting,
      EntityType.law_firm,
    ]),
  },
  {
    label: "Government & public",
    options: options([
      EntityType.government,
      EntityType.elected_official,
      EntityType.public_private,
      EntityType.tribal,
    ]),
  },
  {
    label: "Nonprofit & civic",
    options: options([
      EntityType.nonprofit,
      EntityType.advocacy_membership_lobbyist,
    ]),
  },
  {
    label: "Media & other",
    options: options([EntityType.media, EntityType.competition]),
  },
];
