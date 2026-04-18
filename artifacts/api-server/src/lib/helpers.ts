import { nanoid } from "nanoid";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

export function newId(): string {
  return nanoid();
}

export function currentFiscalYear(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const calYear = now.getFullYear();
  const fyYear = month >= 7 ? calYear + 1 : calYear;
  return `FY${fyYear}`;
}

export function fiscalYearForDate(date: Date): string {
  const month = date.getMonth() + 1;
  const calYear = date.getFullYear();
  const fyYear = month >= 7 ? calYear + 1 : calYear;
  return `FY${fyYear}`;
}
