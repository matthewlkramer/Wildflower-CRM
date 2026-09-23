export const EIN_PATTERN = /^\d{2}-\d{7}$/;

/**
 * Accept either nine digits or the canonical hyphenated form from the editor.
 * Other input is returned trimmed so validation can explain the required shape
 * instead of silently discarding meaningful characters.
 */
export function normalizeEin(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (EIN_PATTERN.test(trimmed)) return trimmed;
  if (/^\d{9}$/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}-${trimmed.slice(2)}`;
  }
  return trimmed;
}

export function isValidEin(value: string | null): boolean {
  return value == null || EIN_PATTERN.test(value);
}
