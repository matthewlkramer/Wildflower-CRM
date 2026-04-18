import { nanoid } from "nanoid";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { fiscalYearEnum } from "@workspace/db/schema";

export function newId(): string {
  return nanoid();
}

export type FiscalYear = (typeof fiscalYearEnum.enumValues)[number];

const FISCAL_YEAR_VALUES = fiscalYearEnum.enumValues;
const FISCAL_YEAR_SET: ReadonlySet<string> = new Set(FISCAL_YEAR_VALUES);

export class FiscalYearValidationError extends Error {
  status = 400;
  constructor(value: unknown) {
    super(
      `Invalid fiscalYear ${JSON.stringify(value)}. Expected one of: ${FISCAL_YEAR_VALUES.join(", ")}`,
    );
    this.name = "FiscalYearValidationError";
  }
}

export function isFiscalYear(value: unknown): value is FiscalYear {
  return typeof value === "string" && FISCAL_YEAR_SET.has(value);
}

export function parseFiscalYear(value: unknown): FiscalYear {
  if (!isFiscalYear(value)) throw new FiscalYearValidationError(value);
  return value;
}

export function parseOptionalFiscalYear(value: unknown): FiscalYear | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseFiscalYear(value);
}

export function currentFiscalYear(): FiscalYear {
  const now = new Date();
  const month = now.getMonth() + 1;
  const calYear = now.getFullYear();
  const fyYear = month >= 7 ? calYear + 1 : calYear;
  return parseFiscalYear(`FY${fyYear}`);
}

export function fiscalYearForDate(date: Date): FiscalYear {
  const month = date.getMonth() + 1;
  const calYear = date.getFullYear();
  const fyYear = month >= 7 ? calYear + 1 : calYear;
  return parseFiscalYear(`FY${fyYear}`);
}
