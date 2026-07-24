import { createHash } from "node:crypto";
import path from "node:path";
import { parseCsv } from "@workspace/coding-forms";

export const WELLS_FARGO_SOURCE = "bank_csv_export" as const;

export interface WellsFargoTransaction {
  file: string;
  date: string;
  checkNo: string;
  description: string;
  spent: string;
  received: string;
  fromTo: string;
  donor: string;
  qbPosting: string;
}

export interface MergedWellsFargoTransaction {
  row: WellsFargoTransaction;
  dedupKey: string;
  occurrence: number;
}

const text = (value: string | null | undefined): string => (value ?? "").trim();

function headerIndex(header: (string | null)[]): Record<string, number> {
  const result: Record<string, number> = {};
  header.forEach((value, index) => {
    if (value !== null) result[text(value).toLowerCase()] = index;
  });
  return result;
}

export function parseWellsFargoCsv(
  csv: string,
  file = "upload.csv",
): WellsFargoTransaction[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const columns = headerIndex(rows[0]);
  for (const required of [
    "date",
    "bank description",
    "spent",
    "received",
    "from/to",
  ]) {
    if (columns[required] === undefined) {
      throw new Error(
        `Missing Wells Fargo CSV column "${required}" in ${file}`,
      );
    }
  }
  const get = (row: (string | null)[], name: string): string => {
    const index = columns[name.toLowerCase()];
    return index === undefined ? "" : text(row[index]);
  };
  return rows.slice(1).flatMap((row) => {
    const date = get(row, "date");
    if (!date) return [];
    return [
      {
        file: path.basename(file),
        date,
        checkNo: get(row, "Check No."),
        description: get(row, "Bank description"),
        spent: get(row, "Spent"),
        received: get(row, "Received"),
        fromTo: get(row, "From/To"),
        donor: get(row, "Donor"),
        qbPosting:
          get(row, "Transaction Posted") || get(row, "Match/Categorize"),
      },
    ];
  });
}

export const wellsFargoDedupKey = (row: WellsFargoTransaction): string =>
  [
    row.date,
    row.checkNo,
    row.description,
    row.spent,
    row.received,
    row.fromTo,
    row.donor,
    row.qbPosting,
  ].join("|");

export function mergeWellsFargoTransactions(
  rows: WellsFargoTransaction[],
): MergedWellsFargoTransaction[] {
  const groups = new Map<string, Map<string, WellsFargoTransaction[]>>();
  for (const row of rows) {
    const key = wellsFargoDedupKey(row);
    const byFile =
      groups.get(key) ?? new Map<string, WellsFargoTransaction[]>();
    const copies = byFile.get(row.file) ?? [];
    copies.push(row);
    byFile.set(row.file, copies);
    groups.set(key, byFile);
  }
  const merged: MergedWellsFargoTransaction[] = [];
  for (const [dedupKey, byFile] of groups) {
    const best = [...byFile.values()]
      .sort((a, b) => a[0].file.localeCompare(b[0].file))
      .reduce((winner, candidate) =>
        candidate.length > winner.length ? candidate : winner,
      );
    best.forEach((row, occurrence) =>
      merged.push({ row, dedupKey, occurrence }),
    );
  }
  return merged.sort(
    (a, b) =>
      a.row.date.localeCompare(b.row.date) ||
      a.dedupKey.localeCompare(b.dedupKey) ||
      a.occurrence - b.occurrence,
  );
}

export const wellsFargoId = (dedupKey: string, occurrence: number): string =>
  `bnk_${createHash("sha256")
    .update(`${WELLS_FARGO_SOURCE}|${dedupKey}|${occurrence}`)
    .digest("hex")
    .slice(0, 24)}`;

export const toIsoDate = (date: string): string => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  if (!match) throw new Error(`Unparseable Wells Fargo date: "${date}"`);
  return `${match[3]}-${match[1]}-${match[2]}`;
};

export const toNumeric = (value: string): string | null => {
  const normalized = value.replace(/[$,]/g, "").trim();
  if (!normalized) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Unparseable Wells Fargo amount: "${value}"`);
  }
  return normalized;
};
