import path from "node:path";
import { parseCsv } from "@workspace/coding-forms";
import * as XLSX from "xlsx";
import type { WellsFargoTransaction } from "./wellsFargo";
import { toNumeric } from "./wellsFargo";

export const BANK_REPORT_ORGANIZATION = "The Wildflower Foundation";
export const BANK_REPORT_TITLE = "Banking Transactions";
export const BANK_REPORT_ACCOUNT = "BUSINESS CHECKING (XXXXXX 8945)";
export const BANK_REPORT_FILENAME_RE =
  /^Banking Transactions - YTD - for CRM(?:[^/]*?)\.(?:csv|xls|xlsx)$/i;

const REQUIRED_COLUMNS = [
  "Transaction date",
  "Transaction type",
  "Payee",
  "Amount",
  "Description",
  "Full name",
  "Category/Ref",
] as const;

const normalize = (value: string | null | undefined): string =>
  (value ?? "").trim();

const normalizeHeader = (value: string | null | undefined): string =>
  normalize(value).toLowerCase();

function isoDateFromTransactionDate(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s|$)/.exec(value.trim());
  return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
}

function mdyFromIso(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

function reportDateRange(rows: (string | null)[][]): {
  reportStartDate: string | null;
  reportEndDate: string | null;
} {
  const month: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  const raw = rows
    .slice(0, 6)
    .map((row) => normalize(row[0]))
    .find((value) => value.includes("-") && /\d{4}/.test(value));
  const match = raw
    ? /^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(
        raw,
      )
    : null;
  if (!match) return { reportStartDate: null, reportEndDate: null };
  const startMonth = month[match[1].toLowerCase()];
  const endMonth = month[match[3].toLowerCase()];
  if (!startMonth || !endMonth) {
    return { reportStartDate: null, reportEndDate: null };
  }
  const year = match[5];
  return {
    reportStartDate: `${year}-${startMonth}-${match[2].padStart(2, "0")}`,
    reportEndDate: `${year}-${endMonth}-${match[4].padStart(2, "0")}`,
  };
}

export interface ParsedBankingTransactionsReport {
  rows: WellsFargoTransaction[];
  reportStartDate: string | null;
  reportEndDate: string | null;
}

/**
 * Parse the exact QuickBooks custom report Wildflower scheduled for the CRM.
 * The title, organization, columns, and bank account are all validated before
 * any row can reach the database. Payee and Category/Ref are treated as
 * mutable annotations; physical row identity remains the same one used by the
 * older manual Banking-page CSV exports: date + bank description + amount.
 */
function parseBankingTransactionsReportRows(
  rows: (string | null)[][],
  file: string,
): ParsedBankingTransactionsReport {
  const firstCells = rows.slice(0, 6).map((row) => normalize(row[0]));
  if (!firstCells.includes(BANK_REPORT_ORGANIZATION)) {
    throw new Error(`Unexpected report organization in ${path.basename(file)}`);
  }
  if (!firstCells.includes(BANK_REPORT_TITLE)) {
    throw new Error(`Unexpected report title in ${path.basename(file)}`);
  }

  const headerRowIndex = rows.findIndex((row) => {
    const normalized = new Set(row.map(normalizeHeader));
    return REQUIRED_COLUMNS.every((column) =>
      normalized.has(column.toLowerCase()),
    );
  });
  if (headerRowIndex < 0) {
    throw new Error(
      `Missing required banking report columns in ${path.basename(file)}`,
    );
  }

  const columns = new Map<string, number>();
  rows[headerRowIndex].forEach((value, index) => {
    columns.set(normalizeHeader(value), index);
  });
  const get = (row: (string | null)[], column: string): string => {
    const index = columns.get(column.toLowerCase());
    return index === undefined ? "" : normalize(row[index]);
  };

  const parsed: WellsFargoTransaction[] = [];
  for (const row of rows.slice(headerRowIndex + 1)) {
    const isoDate = isoDateFromTransactionDate(get(row, "Transaction date"));
    if (!isoDate) continue; // QuickBooks footer/timestamp rows.

    const account = get(row, "Full name");
    if (account.toUpperCase() !== BANK_REPORT_ACCOUNT) {
      throw new Error(
        `Unexpected bank account "${account}" in ${path.basename(file)}`,
      );
    }
    const transactionType = get(row, "Transaction type").toLowerCase();
    if (transactionType !== "credit" && transactionType !== "debit") {
      throw new Error(
        `Unexpected transaction type "${get(row, "Transaction type")}" in ${path.basename(file)}`,
      );
    }
    const numeric = toNumeric(get(row, "Amount"));
    if (numeric === null || Number(numeric) === 0) {
      throw new Error(
        `Missing or zero transaction amount in ${path.basename(file)}`,
      );
    }
    const amount = Math.abs(Number(numeric)).toFixed(2);
    const description = get(row, "Description");
    if (!description) {
      throw new Error(`Missing bank description in ${path.basename(file)}`);
    }

    parsed.push({
      file: path.basename(file),
      date: mdyFromIso(isoDate),
      checkNo: "",
      description,
      spent: transactionType === "debit" ? amount : "",
      received: transactionType === "credit" ? amount : "",
      fromTo: get(row, "Payee"),
      donor: "",
      qbPosting: get(row, "Category/Ref"),
      account,
    });
  }
  if (parsed.length === 0) {
    throw new Error(
      `Banking report contains no transaction rows in ${path.basename(file)}`,
    );
  }
  return { rows: parsed, ...reportDateRange(rows) };
}

export function parseBankingTransactionsReportCsv(
  csv: string,
  file = "Banking Transactions - YTD - for CRM.csv",
): ParsedBankingTransactionsReport {
  return parseBankingTransactionsReportRows(parseCsv(csv), file);
}

/** Parse the scheduled attachment in either downloaded CSV or emailed Excel. */
export function parseBankingTransactionsReportFile(
  bytes: Buffer,
  file: string,
): ParsedBankingTransactionsReport {
  if (/\.csv$/i.test(file)) {
    return parseBankingTransactionsReportCsv(
      bytes.toString("utf8").replace(/^\uFEFF/, ""),
      file,
    );
  }
  if (!/\.xlsx?$/i.test(file)) {
    throw new Error(
      `Unsupported banking report format in ${path.basename(file)}`,
    );
  }
  const workbook = XLSX.read(bytes, { type: "buffer" });
  const successes: ParsedBankingTransactionsReport[] = [];
  const errors: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as string[][];
    try {
      successes.push(parseBankingTransactionsReportRows(rows, file));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (successes.length !== 1) {
    throw new Error(
      successes.length > 1
        ? `Expected one banking report worksheet in ${path.basename(file)}; found ${successes.length}`
        : (errors[0] ?? `No worksheets in ${path.basename(file)}`),
    );
  }
  return successes[0];
}
