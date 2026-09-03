import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);

const marker = `MANUAL BANK IMPORT ${Date.now()}`;
const filename = "Banking Transactions - YTD - for CRM.csv";
const csv = [
  "The Wildflower Foundation,,,,,,,,,,",
  "Banking Transactions,,,,,,,,,,",
  '"January 1-September 2, 2026",,,,,,,,,,',
  "",
  "Transaction date,Transaction type,Payee,Amount,Open balance,Modified on,Memo,Created on,Description,Full name,Category/Ref",
  `09/02/2026 07:00:00 AM,Credit,ATM Deposit,91827.34,91827.34,09/02/2026 10:00:00 AM,,09/02/2026 08:00:00 AM,${marker},BUSINESS CHECKING (XXXXXX 8945),Uncategorized Income`,
  '"Wednesday, September 02, 2026 03:24 PM GMT-05:00",,,,,,,,,,',
].join("\n");

let pool: (typeof import("@workspace/db"))["pool"];
let bankTransactionId = "";
let receiptId = "";

beforeAll(async () => {
  if (!HAS_DB) return;
  const dbModule = await import("@workspace/db");
  const reports = await import("@workspace/bank-reports");
  const importer = await import("../lib/scheduledBankReport");
  pool = dbModule.pool;
  const parsed = reports.parseBankingTransactionsReportCsv(csv, filename);
  const merged = reports.mergeWellsFargoTransactions(parsed.rows)[0];
  bankTransactionId = reports.wellsFargoId(
    merged.dedupKey,
    merged.occurrence,
  );
  receiptId = importer.manualBankReportImportId(Buffer.from(csv));
});

afterAll(async () => {
  if (!HAS_DB) return;
  await pool.query(
    "DELETE FROM bank_deposits WHERE source_bank_transaction_id = $1",
    [bankTransactionId],
  );
  await pool.query("DELETE FROM bank_transaction_imports WHERE id = $1", [
    receiptId,
  ]);
  await pool.query("DELETE FROM bank_transactions WHERE id = $1", [
    bankTransactionId,
  ]);
});

describe.skipIf(!HAS_DB)("manual bank report import", () => {
  it("records truthful manual provenance, projects the deposit, and is idempotent", async () => {
    const { processManualBankReportFile } = await import(
      "../lib/scheduledBankReport"
    );
    const bytes = Buffer.from(csv);

    const first = await processManualBankReportFile({ filename, bytes });
    expect(first).toEqual({
      status: "succeeded",
      rowsSeen: 1,
      rowsInserted: 1,
      alreadyProcessed: false,
    });

    const receipt = await pool.query<{
      mailbox_user_id: string | null;
      gmail_message_id: string | null;
      gmail_attachment_id: string | null;
      status: string;
    }>(
      `SELECT mailbox_user_id, gmail_message_id, gmail_attachment_id, status
       FROM bank_transaction_imports WHERE id = $1`,
      [receiptId],
    );
    expect(receipt.rows[0]).toEqual({
      mailbox_user_id: null,
      gmail_message_id: null,
      gmail_attachment_id: null,
      status: "succeeded",
    });

    const deposit = await pool.query<{ amount: string }>(
      "SELECT amount FROM bank_deposits WHERE source_bank_transaction_id = $1",
      [bankTransactionId],
    );
    expect(deposit.rows).toEqual([{ amount: "91827.34" }]);

    const second = await processManualBankReportFile({ filename, bytes });
    expect(second).toEqual({
      status: "succeeded",
      rowsSeen: 1,
      rowsInserted: 0,
      alreadyProcessed: true,
    });
  });
});
