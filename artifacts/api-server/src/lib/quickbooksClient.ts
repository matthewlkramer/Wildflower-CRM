import { getQuickbooksApiBase } from "./quickbooksOauth";

/**
 * Minimal QuickBooks Online Accounting API client for the one-way payment
 * pull. We only ever READ — no write-back to QuickBooks ever happens here.
 *
 * Incoming-money entities we pull:
 *   - SalesReceipt — a sale paid at point of sale
 *   - Payment      — a payment received against invoices
 *   - Deposit      — money deposited to a bank account
 *
 * All three are fetched via the QBO query endpoint (SQL-like). We filter
 * incrementally on MetaData.LastUpdatedTime so re-syncs only pull changed
 * rows.
 */

export type QuickbooksEntityType = "sales_receipt" | "payment" | "deposit";

export interface NormalizedQuickbooksPayment {
  qbEntityType: QuickbooksEntityType;
  qbEntityId: string;
  amount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  payerEmail: string | null;
  rawReference: string | null;
  lastUpdatedTime: string | null;
}

interface QbQueryResponse {
  QueryResponse?: Record<string, unknown> & {
    maxResults?: number;
    startPosition?: number;
  };
}

const PAGE_SIZE = 100;

function fmtQbDateTime(d: Date): string {
  // QuickBooks expects an ISO-8601 timestamp; it accepts the standard
  // toISOString form in query filters.
  return d.toISOString();
}

async function runQuery(
  accessToken: string,
  realmId: string,
  query: string,
): Promise<QbQueryResponse> {
  const base = getQuickbooksApiBase();
  const url = `${base}/v3/company/${encodeURIComponent(
    realmId,
  )}/query?query=${encodeURIComponent(query)}&minorversion=70`;
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`QuickBooks query failed: ${r.status} ${text}`);
  }
  return (await r.json()) as QbQueryResponse;
}

type QbRef = { value?: string; name?: string } | undefined;

interface QbSalesReceipt {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  DocNumber?: string;
  CustomerRef?: QbRef;
  BillEmail?: { Address?: string };
  CustomerMemo?: { value?: string };
  MetaData?: { LastUpdatedTime?: string };
}

interface QbPayment {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  PaymentRefNum?: string;
  CustomerRef?: QbRef;
  MetaData?: { LastUpdatedTime?: string };
}

interface QbDeposit {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  PrivateNote?: string;
  DepositToAccountRef?: QbRef;
  MetaData?: { LastUpdatedTime?: string };
}

function num(n: number | undefined): string | null {
  return typeof n === "number" ? n.toFixed(2) : null;
}

/**
 * Pull every incoming-money entity updated on/after `since` (or all, when
 * `since` is null). Returns normalized rows ready to stage. Paginates
 * through each entity type.
 */
export async function pullIncomingPayments(
  accessToken: string,
  realmId: string,
  since: Date | null,
): Promise<NormalizedQuickbooksPayment[]> {
  const whereClause = since
    ? ` WHERE MetaData.LastUpdatedTime >= '${fmtQbDateTime(since)}'`
    : "";
  const orderClause = " ORDERBY MetaData.LastUpdatedTime";
  const out: NormalizedQuickbooksPayment[] = [];

  // SalesReceipt
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM SalesReceipt${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["SalesReceipt"] ??
      []) as QbSalesReceipt[];
    for (const row of rows) {
      out.push({
        qbEntityType: "sales_receipt",
        qbEntityId: row.Id,
        amount: num(row.TotalAmt),
        dateReceived: row.TxnDate ?? null,
        payerName: row.CustomerRef?.name ?? null,
        payerEmail: row.BillEmail?.Address ?? null,
        rawReference:
          row.DocNumber ?? row.CustomerMemo?.value ?? null,
        lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Payment
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM Payment${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Payment"] ?? []) as QbPayment[];
    for (const row of rows) {
      out.push({
        qbEntityType: "payment",
        qbEntityId: row.Id,
        amount: num(row.TotalAmt),
        dateReceived: row.TxnDate ?? null,
        payerName: row.CustomerRef?.name ?? null,
        payerEmail: null,
        rawReference: row.PaymentRefNum ?? null,
        lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Deposit
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM Deposit${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Deposit"] ?? []) as QbDeposit[];
    for (const row of rows) {
      out.push({
        qbEntityType: "deposit",
        qbEntityId: row.Id,
        amount: num(row.TotalAmt),
        dateReceived: row.TxnDate ?? null,
        // Deposits have no customer; payer is unknown → always unmatched.
        payerName: null,
        payerEmail: null,
        rawReference: row.PrivateNote ?? row.DepositToAccountRef?.name ?? null,
        lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return out;
}
