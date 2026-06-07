/**
 * Bulk gift-merge load gate.
 *
 * The gift-merge dialogs resolve each selected gift by id (the selection can
 * span pages/filters), so the fetched records can lag behind — or fail to load.
 * A merge MUST operate on EVERY selected gift; running on a partially loaded (or
 * errored) subset would silently merge/delete fewer rows than the user selected.
 *
 * Returns true only when every selected gift has loaded and none errored.
 */
export function allSelectedLoaded(
  loadedCount: number,
  expectedCount: number,
  loadError: boolean,
): boolean {
  return !loadError && expectedCount > 0 && loadedCount === expectedCount;
}
