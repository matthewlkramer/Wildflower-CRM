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
  // QuickBooks line-item detail used by the noise classifier (membership
  // detection) and for auditing exclusions. For SalesReceipt/Deposit these come
  // from the transaction's own lines; for Payment (no lines of its own) they
  // come from the linked Invoice(s). Empty arrays when no detail is available.
  lineItemNames: string[];
  lineAccountNames: string[];
  lineClasses: string[];
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

// A QuickBooks transaction line. Only the detail relevant to noise
// classification is typed: the Product/Service item (SalesItemLineDetail),
// the posting account (DepositLineDetail), and the class (ClassRef) on either.
interface QbLine {
  DetailType?: string;
  SalesItemLineDetail?: { ItemRef?: QbRef; ClassRef?: QbRef };
  DepositLineDetail?: { AccountRef?: QbRef; ClassRef?: QbRef };
}

interface QbSalesReceipt {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  DocNumber?: string;
  CustomerRef?: QbRef;
  BillEmail?: { Address?: string };
  CustomerMemo?: { value?: string };
  Line?: QbLine[];
  MetaData?: { LastUpdatedTime?: string };
}

interface QbLinkedTxn {
  TxnId?: string;
  TxnType?: string;
}

interface QbPayment {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  PaymentRefNum?: string;
  CustomerRef?: QbRef;
  Line?: { LinkedTxn?: QbLinkedTxn[] }[];
  MetaData?: { LastUpdatedTime?: string };
}

interface QbDeposit {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  PrivateNote?: string;
  DepositToAccountRef?: QbRef;
  Line?: QbLine[];
  MetaData?: { LastUpdatedTime?: string };
}

interface QbInvoice {
  Id: string;
  Line?: QbLine[];
}

function num(n: number | undefined): string | null {
  return typeof n === "number" ? n.toFixed(2) : null;
}

/** Distinct, non-empty, trimmed strings — keeps the stored arrays tidy. */
function uniq(values: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = (v ?? "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

interface LineDetail {
  itemNames: string[];
  accountNames: string[];
  classes: string[];
}

const EMPTY_LINE_DETAIL: LineDetail = {
  itemNames: [],
  accountNames: [],
  classes: [],
};

/**
 * Extract item / account / class names from a transaction's (or invoice's)
 * lines. SalesItemLineDetail carries the Product/Service item; DepositLineDetail
 * carries the posting account; either can carry a ClassRef.
 */
function extractLineDetail(lines: QbLine[] | undefined): LineDetail {
  if (!lines || lines.length === 0) return EMPTY_LINE_DETAIL;
  const items: (string | undefined)[] = [];
  const accounts: (string | undefined)[] = [];
  const classes: (string | undefined)[] = [];
  for (const line of lines) {
    if (line.SalesItemLineDetail) {
      items.push(line.SalesItemLineDetail.ItemRef?.name);
      classes.push(line.SalesItemLineDetail.ClassRef?.name);
    }
    if (line.DepositLineDetail) {
      accounts.push(line.DepositLineDetail.AccountRef?.name);
      classes.push(line.DepositLineDetail.ClassRef?.name);
    }
  }
  return {
    itemNames: uniq(items),
    accountNames: uniq(accounts),
    classes: uniq(classes),
  };
}

function mergeLineDetail(parts: LineDetail[]): LineDetail {
  return {
    itemNames: uniq(parts.flatMap((p) => p.itemNames)),
    accountNames: uniq(parts.flatMap((p) => p.accountNames)),
    classes: uniq(parts.flatMap((p) => p.classes)),
  };
}

/**
 * Batch-fetch invoices by id (chunked) and return a map of id → its lines.
 * Used to resolve the membership marker for invoice-applied Payments, which
 * carry no line items of their own — the item lives on the linked Invoice.
 * Read-only.
 */
async function fetchInvoiceLines(
  accessToken: string,
  realmId: string,
  invoiceIds: string[],
): Promise<Map<string, QbLine[]>> {
  const map = new Map<string, QbLine[]>();
  const ids = uniq(invoiceIds);
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const q = `SELECT * FROM Invoice WHERE Id IN (${inList}) MAXRESULTS ${CHUNK}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Invoice"] ?? []) as QbInvoice[];
    for (const inv of rows) {
      map.set(inv.Id, inv.Line ?? []);
    }
  }
  return map;
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
      // SalesReceipt carries its own lines → read item/class directly.
      const detail = extractLineDetail(row.Line);
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
        lineItemNames: detail.itemNames,
        lineAccountNames: detail.accountNames,
        lineClasses: detail.classes,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Payment — carries no line items of its own; the membership item lives on
  // the LINKED Invoice. We collect each payment's linked-invoice ids, then
  // batch-fetch those invoices' lines and attach them. (Heavier path, chosen
  // for membership-detection precision.)
  const payments: { row: QbPayment; invoiceIds: string[] }[] = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM Payment${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Payment"] ?? []) as QbPayment[];
    for (const row of rows) {
      const invoiceIds = uniq(
        (row.Line ?? []).flatMap((l) =>
          (l.LinkedTxn ?? [])
            .filter((t) => t.TxnType === "Invoice")
            .map((t) => t.TxnId ?? ""),
        ),
      );
      payments.push({ row, invoiceIds });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  const allInvoiceIds = uniq(payments.flatMap((p) => p.invoiceIds));
  const invoiceLines = allInvoiceIds.length
    ? await fetchInvoiceLines(accessToken, realmId, allInvoiceIds)
    : new Map<string, QbLine[]>();
  for (const { row, invoiceIds } of payments) {
    const detail = mergeLineDetail(
      invoiceIds.map((id) => extractLineDetail(invoiceLines.get(id))),
    );
    out.push({
      qbEntityType: "payment",
      qbEntityId: row.Id,
      amount: num(row.TotalAmt),
      dateReceived: row.TxnDate ?? null,
      payerName: row.CustomerRef?.name ?? null,
      payerEmail: null,
      rawReference: row.PaymentRefNum ?? null,
      lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
      lineItemNames: detail.itemNames,
      lineAccountNames: detail.accountNames,
      lineClasses: detail.classes,
    });
  }

  // Deposit
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM Deposit${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Deposit"] ?? []) as QbDeposit[];
    for (const row of rows) {
      // Deposit carries its own lines → read posting account/class directly.
      const detail = extractLineDetail(row.Line);
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
        lineItemNames: detail.itemNames,
        lineAccountNames: detail.accountNames,
        lineClasses: detail.classes,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return out;
}
