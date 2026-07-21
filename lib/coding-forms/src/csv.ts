/**
 * Minimal RFC-4180 CSV parser for Google Sheets CSV exports. Pure and
 * dependency-free so it lives beside the coding-form parse helpers (the sheet
 * fetcher converts the exported CSV text into the same `unknown[][]` row shape
 * `parseFormSheet` already accepts for XLSX-sourced rows).
 *
 * Handles quoted fields (embedded commas, quotes doubled as "", and embedded
 * newlines), both \n and \r\n line endings, and a UTF-8 BOM. A trailing
 * newline does not produce a phantom empty row. Empty cells become null to
 * match `xlsx`'s `defval: null` behavior.
 */
export function parseCsv(text: string): (string | null)[][] {
  // Strip a UTF-8 BOM if present.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [];
  let field = "";
  let fieldStarted = false;
  let inQuotes = false;

  const endField = () => {
    row.push(field.length === 0 ? null : field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field.length === 0) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (c === ",") {
      endField();
      fieldStarted = true; // the comma implies a following field exists
      continue;
    }
    if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (c === "\n") {
      endRow();
      continue;
    }
    field += c;
    fieldStarted = true;
  }
  // Final field/row (no trailing newline) — but don't emit a phantom empty
  // row after a trailing newline.
  if (fieldStarted || field.length > 0 || row.length > 0) endRow();

  return rows;
}
