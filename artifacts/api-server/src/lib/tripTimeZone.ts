const EASTERN = new Set([
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "IN",
  "KY",
  "ME",
  "MD",
  "MA",
  "MI",
  "NH",
  "NJ",
  "NY",
  "NC",
  "OH",
  "PA",
  "RI",
  "SC",
  "VT",
  "VA",
  "WV",
]);
const CENTRAL = new Set([
  "AL",
  "AR",
  "IL",
  "IA",
  "KS",
  "LA",
  "MN",
  "MS",
  "MO",
  "NE",
  "ND",
  "OK",
  "SD",
  "TN",
  "TX",
  "WI",
]);
const MOUNTAIN = new Set(["CO", "ID", "MT", "NM", "UT", "WY"]);
const PACIFIC = new Set(["CA", "NV", "OR", "WA"]);

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function inferTripTimeZone(
  destinationState?: string | null,
  fallback = "America/Chicago",
): string {
  const state = destinationState?.trim().toUpperCase() ?? "";
  if (EASTERN.has(state)) return "America/New_York";
  if (CENTRAL.has(state)) return "America/Chicago";
  if (MOUNTAIN.has(state)) return "America/Denver";
  if (PACIFIC.has(state)) return "America/Los_Angeles";
  if (state === "AZ") return "America/Phoenix";
  if (state === "AK") return "America/Anchorage";
  if (state === "HI") return "Pacific/Honolulu";
  return fallback;
}
