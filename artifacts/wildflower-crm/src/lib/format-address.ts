const UNITED_STATES_NAMES = new Set([
  "us",
  "usa",
  "united states",
  "united states of america",
]);

export type DisplayAddress = {
  street?: string | null;
  cityName?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
};

export function isUnitedStatesCountry(country: string | null | undefined) {
  if (!country) return false;
  const normalized = country
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  return UNITED_STATES_NAMES.has(normalized);
}

/**
 * CRM-wide address presentation rule: the United States is implicit for
 * domestic addresses, while non-US countries remain visible.
 */
export function formatDisplayAddress(address: DisplayAddress): string {
  const country = isUnitedStatesCountry(address.country)
    ? null
    : address.country;
  return (
    [
      address.street,
      address.cityName,
      address.stateCode,
      address.postalCode,
      country,
    ]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(", ") || "—"
  );
}
