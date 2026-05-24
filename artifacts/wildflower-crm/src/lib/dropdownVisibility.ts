// Shared visibility rules for entity + fiscal-year dropdowns.
//
// Entities: a small set of fund entities are no longer in use but still exist
// in the DB (and on historical allocation rows) so we can't delete them. Hide
// them from dropdowns by default behind a "Show retired entities" toggle.
//
// Fiscal years: the table is seeded fy2014..fy2050 + a "future" sentinel.
// Default-visible window is "last 3 + current + next" (5 FYs). Everything
// older — and the "future" sentinel — sits behind a "Show all" toggle.

export const RETIRED_ENTITY_IDS: ReadonlySet<string> = new Set([
  "embracing_equity",
  "rising_tide",
  "observation_support_tech",
  "tierra_indigena",
]);

export function isRetiredEntity(id: string): boolean {
  return RETIRED_ENTITY_IDS.has(id);
}

export function partitionEntities<T extends { id: string }>(
  items: ReadonlyArray<T>,
): { active: T[]; retired: T[] } {
  const active: T[] = [];
  const retired: T[] = [];
  for (const it of items) {
    (isRetiredEntity(it.id) ? retired : active).push(it);
  }
  return { active, retired };
}

// Wildflower FY runs Jul 1 – Jun 30. Returns the numeric end year.
// e.g. May 2026 → FY2026 (ends Jun 2026); Aug 2026 → FY2027.
export function currentFyEndYear(now: Date = new Date()): number {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed; Jul = 6
  return m >= 6 ? y + 1 : y;
}

// Last 3 + current + next = 5-year visible window. The "future" sentinel and
// any FY older than (current - 3) end up in the collapsed group.
export function isDefaultVisibleFy(id: string, now: Date = new Date()): boolean {
  const m = /^fy(\d{4})$/.exec(id);
  if (!m) return false;
  const endYear = Number(m[1]);
  const cur = currentFyEndYear(now);
  return endYear >= cur - 3 && endYear <= cur + 1;
}

export function partitionFiscalYears<T extends { id: string }>(
  items: ReadonlyArray<T>,
  now: Date = new Date(),
): { recent: T[]; older: T[] } {
  const recent: T[] = [];
  const older: T[] = [];
  for (const it of items) {
    (isDefaultVisibleFy(it.id, now) ? recent : older).push(it);
  }
  return { recent, older };
}
