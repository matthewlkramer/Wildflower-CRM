// CSV serialization helpers for the list-view export endpoints.
//
// Two safety properties every exported cell must have:
//  1. RFC 4180 quoting — commas, quotes, and newlines never break the row
//     structure (quotes are doubled, risky cells are wrapped in quotes).
//  2. Spreadsheet formula neutralization — cells that a spreadsheet would
//     interpret as a formula (`=`, `+`, `-`, `@`, tab, CR) are prefixed with
//     a single quote so pasting/opening the file can never execute anything.

/** Prefix would-be formulas so Excel/Sheets treat the cell as text. */
export function neutralizeFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/** Quote a single CSV cell (after formula neutralization). */
export function csvCell(raw: unknown): string {
  const value = neutralizeFormula(stringifyCsvValue(raw));
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Normalize an arbitrary row value to a human-readable string:
 *  - null/undefined -> ""
 *  - Date -> YYYY-MM-DD (list views only show dates, not times)
 *  - arrays -> "; "-joined items
 *  - booleans -> Yes/No
 *  - everything else -> String(value)
 */
export function stringifyCsvValue(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value))
    return value.map((v) => stringifyCsvValue(v)).filter(Boolean).join("; ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Serialize one CSV row (no BOM). Used for incremental streaming writes. */
export function csvLine(row: unknown[]): string {
  return `${row.map(csvCell).join(",")}\r\n`;
}

/** Serialize a header + rows into a CRLF-terminated CSV document. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  // Leading BOM so Excel detects UTF-8 (accented donor names, etc.).
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** Convert a snake_case enum value into a friendly label. */
export function labelizeEnum(value: unknown): string {
  if (value == null || value === "") return "";
  const s = String(value).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Timestamped, entity-labeled filename: `gifts-2026-08-19.csv`. */
export function csvFilename(slug: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${slug}-${today}.csv`;
}
