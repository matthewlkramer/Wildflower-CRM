import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeWellsFargoTransactions,
  parseBankingTransactionsReportCsv,
  parseBankingTransactionsReportFile,
  wellsFargoDedupKey,
} from "@workspace/bank-reports";
import * as XLSX from "xlsx";

const report = (dataRows: string[]): string =>
  [
    "The Wildflower Foundation,,,,,,,,,,",
    "Banking Transactions,,,,,,,,,,",
    '"January 1-September 2, 2026",,,,,,,,,,',
    "",
    "Transaction date,Transaction type,Payee,Amount,Open balance,Modified on,Memo,Created on,Description,Full name,Category/Ref",
    ...dataRows,
    '"Wednesday, September 02, 2026 03:24 PM GMT-05:00",,,,,,,,,,',
  ].join("\n");

test("parses the scheduled YTD report into the existing bank-feed identity", () => {
  const parsed = parseBankingTransactionsReportCsv(
    report([
      '01/08/2026 07:00:00 AM,Credit,ATM Deposit,"1,109.81","1,109.81",01/13/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT ON 01/08,BUSINESS CHECKING (XXXXXX 8945),Membership (School Sites)',
    ]),
  );

  assert.equal(parsed.reportStartDate, "2026-01-01");
  assert.equal(parsed.reportEndDate, "2026-09-02");
  assert.deepEqual(parsed.rows[0], {
    file: "Banking Transactions - YTD - for CRM.csv",
    date: "01/08/2026",
    checkNo: "",
    description: "ATM CHECK DEPOSIT ON 01/08",
    spent: "",
    received: "1109.81",
    fromTo: "ATM Deposit",
    donor: "",
    qbPosting: "Membership (School Sites)",
    account: "BUSINESS CHECKING (XXXXXX 8945)",
  });
  assert.equal(
    wellsFargoDedupKey(parsed.rows[0]),
    "01/08/2026||ATM CHECK DEPOSIT ON 01/08||1109.81",
  );
});

test("rejects a report for any other account", () => {
  assert.throws(
    () =>
      parseBankingTransactionsReportCsv(
        report([
          "01/08/2026 07:00:00 AM,Credit,ATM Deposit,100.00,100.00,01/13/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT,BUSINESS SAVINGS (XXXXXX 1111),Transfer",
        ]),
      ),
    /Unexpected bank account/,
  );
});

test("parses the same scheduled report when QuickBooks emails Excel", () => {
  const csvRows = report([
    "01/08/2026 07:00:00 AM,Credit,ATM Deposit,100.00,100.00,01/13/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT,BUSINESS CHECKING (XXXXXX 8945),Transfer",
  ])
    .split("\n")
    .map((line) => line.split(","));
  // Build from a true array-of-arrays so the test exercises the Excel reader,
  // not the CSV code path. The quoted date-range commas are restored below.
  csvRows[2] = ["January 1-September 2, 2026"];
  csvRows[5] = [
    "01/08/2026 07:00:00 AM",
    "Credit",
    "ATM Deposit",
    "100.00",
    "100.00",
    "01/13/2026 10:48:50 PM",
    "",
    "01/09/2026 10:48:48 PM",
    "ATM CHECK DEPOSIT",
    "BUSINESS CHECKING (XXXXXX 8945)",
    "Transfer",
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(csvRows),
    "Banking Transactions",
  );
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const parsed = parseBankingTransactionsReportFile(
    bytes,
    "Banking Transactions - YTD - for CRM.xlsx",
  );
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].received, "100.00");
});

test("overlapping YTD reports preserve genuine multiplicity", () => {
  const first = parseBankingTransactionsReportCsv(
    report([
      "01/08/2026 07:00:00 AM,Credit,ATM Deposit,100.00,100.00,01/13/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT,BUSINESS CHECKING (XXXXXX 8945),Transfer",
      "01/08/2026 07:00:00 AM,Credit,ATM Deposit,100.00,100.00,01/13/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT,BUSINESS CHECKING (XXXXXX 8945),Transfer",
    ]),
    "Banking Transactions - YTD - for CRM.csv",
  );
  const second = parseBankingTransactionsReportCsv(
    report([
      "01/08/2026 07:00:00 AM,Credit,Renamed Payee,100.00,100.00,01/14/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT,BUSINESS CHECKING (XXXXXX 8945),Updated category",
      "01/08/2026 07:00:00 AM,Credit,Renamed Payee,100.00,100.00,01/14/2026 10:48:50 PM,,01/09/2026 10:48:48 PM,ATM CHECK DEPOSIT,BUSINESS CHECKING (XXXXXX 8945),Updated category",
    ]),
    "Banking Transactions - YTD - for CRM (1).csv",
  );

  const merged = mergeWellsFargoTransactions([...first.rows, ...second.rows]);
  assert.deepEqual(
    merged.map((row) => row.occurrence),
    [0, 1],
  );
});
