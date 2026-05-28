// Shared visibility rules for entity + fiscal-year dropdowns.
//
// Entities: a small set of fund entities are no longer in use but still exist
// in the DB (and on historical allocation rows) so we can't delete them. The
// DB column `entities.active` is the source of truth — `active=false` means
// retired. Hide them from dropdowns by default behind a "Show retired
// entities" toggle. (Manage via the /admin page.)
//
// Fiscal years: the table is seeded fy2014..fy2050. Default-visible window
// is "last 3 + current + next" (5 FYs). Everything older sits behind a
// "Show all" toggle. The legacy `future` sentinel is excluded entirely.

export function partitionEntities<T extends { id: string; active: boolean }>(
  items: ReadonlyArray<T>,
): { active: T[]; retired: T[] } {
  const active: T[] = [];
  const retired: T[] = [];
  for (const it of items) {
    (it.active ? active : retired).push(it);
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

// Last 3 + current + next = 5-year visible window. Any FY older than
// (current - 3) ends up in the collapsed group; the legacy "future"
// sentinel never matches and is hidden.
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
