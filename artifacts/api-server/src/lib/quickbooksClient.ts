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
 *
 * INCOME-ACCOUNT CODING. A payment's revenue coding is what tells the noise
 * classifier whether it is a gift or earned revenue / a fee / a refund. That
 * coding does NOT live on the transaction line directly for the two
 * item-based entities:
 *   - SalesReceipt / invoice-applied Payment lines carry a Product/Service
 *     ITEM (SalesItemLineDetail.ItemRef). The income account is a property of
 *     that Item (Item.IncomeAccountRef), so we batch-fetch the referenced
 *     Items and resolve each item → its income account.
 *   - A Payment with no invoice carries no item at all; if it was later put on
 *     a bank Deposit we inherit the Deposit LINE's account / class / memo
 *     (matched back to the Payment via the deposit line's LinkedTxn).
 * The deposit-line bank account is auditable but never a revenue code, so it
 * never trips the (revenue-code-based) exclusion rules.
 */

export type QuickbooksEntityType = "sales_receipt" | "payment" | "deposit";

export interface NormalizedQuickbooksPayment {
  qbEntityType: QuickbooksEntityType;
  qbEntityId: string;
  // QuickBooks line id, for deposits staged PER LINE. Empty string (not null)
  // for SalesReceipt/Payment so each is a single idempotent unit.
  qbLineId: string;
  // The underlying bank Deposit id this unit belongs to, when known. For a
  // direct deposit LINE it is the deposit's own id; for a Payment/SalesReceipt
  // bundled into a deposit it is threaded from the deposit→entity back-index.
  // Null when the money is not tied to a deposit. Lets a fundraiser manually
  // group same-deposit units and reconcile them as one to a multi-allocation gift.
  qbDepositId: string | null;
  amount: string | null;
  dateReceived: string | null;
  payerName: string | null;
  payerEmail: string | null;
  rawReference: string | null;
  // Per-line / per-entity free-text description or memo (deposit line
  // Description, deposit PrivateNote, SalesReceipt CustomerMemo).
  lineDescription: string | null;
  lastUpdatedTime: string | null;
  // QuickBooks line-item detail used by the noise classifier and for auditing
  // exclusions. itemNames are the Product/Service items; accountNames are the
  // resolved income/posting accounts (item income accounts for item-based
  // lines, deposit posting accounts for deposit lines); classes are the QB
  // classes. For SalesReceipt/Deposit these come from the transaction's own
  // lines; for Payment they come from the linked Invoice(s) and any Deposit
  // line that re-records the Payment. Empty arrays when no detail is available.
  lineItemNames: string[];
  lineAccountNames: string[];
  lineClasses: string[];

  // ── Extended QuickBooks payer + entity context (read-only mirror) ────────
  // The kind of QB name the payer resolves to. "customer" for a
  // SalesReceipt/Payment CustomerRef; the deposit line's Entity ref type for a
  // deposit line; null when QB recorded no payer ref.
  qbPayerType: "vendor" | "customer" | "employee" | null;
  qbPayerId: string | null;
  qbPaymentMethod: string | null;
  qbCheckNumber: string | null;
  qbDepositToAccountName: string | null;
  qbDocNumber: string | null;
  qbBillingAddress: string | null;
  qbTransactionMemo: string | null;
  qbCurrency: string | null;
  qbExchangeRate: string | null;
  qbCreateTime: string | null;
  qbLinkedTxn: { txnId: string; txnType: string }[] | null;
  // The complete raw QB entity payload, verbatim (for future-proofing).
  qbRaw: unknown;
  // For deposit-line rows only: the specific deposit Line object, verbatim.
  qbRawLine: unknown;
}

interface QbQueryResponse {
  QueryResponse?: Record<string, unknown> & {
    maxResults?: number;
    startPosition?: number;
  };
}

const PAGE_SIZE = 100;
// Chunk size for `... WHERE Id IN (...)` batch lookups (Invoice / Item /
// Customer). QBO caps a single query's results; 50 keeps us comfortably under.
const IN_CHUNK = 50;

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

type QbRef = { value?: string; name?: string; type?: string } | undefined;

// A QuickBooks address block (e.g. SalesReceipt BillAddr).
interface QbAddr {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

type QbMeta = { LastUpdatedTime?: string; CreateTime?: string };

// A QuickBooks transaction line. Beyond the detail relevant to noise
// classification — the Product/Service item (SalesItemLineDetail), the
// posting account (DepositLineDetail), and the class (ClassRef) on either —
// deposit lines also carry their own Id / Amount / Description, the payer
// (DepositLineDetail.Entity), and a LinkedTxn back-reference when the line
// merely re-records an already-ingested Payment/SalesReceipt.
interface QbLine {
  Id?: string;
  Amount?: number;
  Description?: string;
  DetailType?: string;
  LinkedTxn?: QbLinkedTxn[];
  SalesItemLineDetail?: { ItemRef?: QbRef; ClassRef?: QbRef };
  DepositLineDetail?: {
    AccountRef?: QbRef;
    ClassRef?: QbRef;
    Entity?: QbRef;
    CheckNum?: string;
    PaymentMethodRef?: QbRef;
  };
}

interface QbSalesReceipt {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  DocNumber?: string;
  CustomerRef?: QbRef;
  BillEmail?: { Address?: string };
  BillAddr?: QbAddr;
  CustomerMemo?: { value?: string };
  PrivateNote?: string;
  PaymentMethodRef?: QbRef;
  PaymentRefNum?: string;
  DepositToAccountRef?: QbRef;
  CurrencyRef?: QbRef;
  ExchangeRate?: number;
  Line?: QbLine[];
  MetaData?: QbMeta;
}

interface QbLinkedTxn {
  TxnId?: string;
  TxnType?: string;
}

interface QbPayment {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  DocNumber?: string;
  PaymentRefNum?: string;
  PaymentMethodRef?: QbRef;
  CustomerRef?: QbRef;
  PrivateNote?: string;
  DepositToAccountRef?: QbRef;
  CurrencyRef?: QbRef;
  ExchangeRate?: number;
  Line?: { LinkedTxn?: QbLinkedTxn[] }[];
  MetaData?: QbMeta;
}

interface QbDeposit {
  Id: string;
  TotalAmt?: number;
  TxnDate?: string;
  DocNumber?: string;
  PrivateNote?: string;
  DepositToAccountRef?: QbRef;
  CurrencyRef?: QbRef;
  ExchangeRate?: number;
  Line?: QbLine[];
  MetaData?: QbMeta;
}

interface QbInvoice {
  Id: string;
  Line?: QbLine[];
}

// A QuickBooks Product/Service item. Its income account (IncomeAccountRef) is
// the revenue coding the classifier needs for item-based SalesReceipt / invoice
// lines, which reference the item but not the account directly.
interface QbItem {
  Id: string;
  Name?: string;
  IncomeAccountRef?: QbRef;
}

// A QuickBooks Customer — pulled only for its primary email, to enrich the
// payer email on Payments (which carry no BillEmail of their own) and on
// direct deposit lines whose Entity is a customer.
interface QbCustomer {
  Id: string;
  PrimaryEmailAddr?: { Address?: string };
}

function num(n: number | undefined): string | null {
  return typeof n === "number" ? n.toFixed(2) : null;
}

/** Normalize a QB ref `type` string to our payer-type enum (or null). */
function normalizePayerType(
  t: string | undefined | null,
): "vendor" | "customer" | "employee" | null {
  switch ((t ?? "").toLowerCase()) {
    case "vendor":
      return "vendor";
    case "customer":
      return "customer";
    case "employee":
      return "employee";
    default:
      return null;
  }
}

/** Flatten a QB address block to a single comma-separated display string. */
function flattenAddr(a: QbAddr | undefined): string | null {
  if (!a) return null;
  const s = uniq([
    a.Line1,
    a.Line2,
    a.Line3,
    a.Line4,
    a.Line5,
    a.City,
    a.CountrySubDivisionCode,
    a.PostalCode,
    a.Country,
  ]).join(", ");
  return s || null;
}

/** QB exchange rate → string (numeric column), preserving precision. */
function rate(n: number | undefined): string | null {
  return typeof n === "number" ? String(n) : null;
}

/** Map QB LinkedTxn[] to our compact {txnId, txnType}[] (null when empty). */
function mapLinkedTxn(
  lts: QbLinkedTxn[] | undefined,
): { txnId: string; txnType: string }[] | null {
  if (!lts || lts.length === 0) return null;
  const out = lts
    .filter((lt) => lt.TxnId)
    .map((lt) => ({ txnId: lt.TxnId as string, txnType: lt.TxnType ?? "" }));
  return out.length ? out : null;
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

/** Item ids referenced by a transaction's (or invoice's) SalesItem lines. */
function itemIdsFromLines(lines: QbLine[] | undefined): string[] {
  if (!lines || lines.length === 0) return [];
  const ids: string[] = [];
  for (const line of lines) {
    const v = line.SalesItemLineDetail?.ItemRef?.value;
    if (v) ids.push(v);
  }
  return ids;
}

/**
 * Extract item / account / class names from a transaction's (or invoice's)
 * lines. SalesItemLineDetail carries the Product/Service item; its income
 * account is resolved from the item via `itemAccounts` (id → income-account
 * name). DepositLineDetail carries the posting account directly; either line
 * type can carry a ClassRef.
 */
function extractLineDetail(
  lines: QbLine[] | undefined,
  itemAccounts?: Map<string, string>,
): LineDetail {
  if (!lines || lines.length === 0) return EMPTY_LINE_DETAIL;
  const items: (string | undefined)[] = [];
  const accounts: (string | undefined)[] = [];
  const classes: (string | undefined)[] = [];
  for (const line of lines) {
    if (line.SalesItemLineDetail) {
      const itemRef = line.SalesItemLineDetail.ItemRef;
      items.push(itemRef?.name);
      classes.push(line.SalesItemLineDetail.ClassRef?.name);
      // The income account lives on the referenced Item, not the line.
      const acct = itemRef?.value ? itemAccounts?.get(itemRef.value) : undefined;
      accounts.push(acct);
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
 * Coding inherited from a bank Deposit LINE that re-records an already-ingested
 * Payment / SalesReceipt (joined back via the deposit line's LinkedTxn). The
 * account is the deposit's posting (bank) account — auditable context, never a
 * revenue code — plus any class and the line/deposit memo.
 */
interface DepositCoding {
  accountNames: string[];
  classes: string[];
  memo: string | null;
  // The bank Deposit id that re-recorded this entity. Threaded onto the
  // entity's staged row so same-deposit units can be manually grouped.
  depositId: string | null;
}

/**
 * Batch-fetch invoices by id (chunked) and return a map of id → its lines.
 * Used to resolve the income-account / item coding for invoice-applied
 * Payments, which carry no lines of their own — the item lives on the linked
 * Invoice. Read-only.
 */
async function fetchInvoiceLines(
  accessToken: string,
  realmId: string,
  invoiceIds: string[],
): Promise<Map<string, QbLine[]>> {
  const map = new Map<string, QbLine[]>();
  const ids = uniq(invoiceIds);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const q = `SELECT * FROM Invoice WHERE Id IN (${inList}) MAXRESULTS ${IN_CHUNK}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Invoice"] ?? []) as QbInvoice[];
    for (const inv of rows) {
      map.set(inv.Id, inv.Line ?? []);
    }
  }
  return map;
}

/**
 * Batch-fetch Items by id (chunked) and return a map of item id → income
 * account name. This is the revenue coding the classifier reads for item-based
 * SalesReceipt and invoice lines. Read-only.
 */
async function fetchItemIncomeAccounts(
  accessToken: string,
  realmId: string,
  itemIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = uniq(itemIds);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const q = `SELECT * FROM Item WHERE Id IN (${inList}) MAXRESULTS ${IN_CHUNK}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Item"] ?? []) as QbItem[];
    for (const item of rows) {
      const acct = item.IncomeAccountRef?.name?.trim();
      if (item.Id && acct) map.set(item.Id, acct);
    }
  }
  return map;
}

/**
 * Batch-fetch Customers by id (chunked) and return a map of customer id →
 * primary email. Used to enrich the payer email where the entity itself does
 * not carry one (Payment, direct deposit line). Read-only. Ids that are not
 * customers (e.g. a vendor entity on a deposit line) simply don't resolve.
 */
async function fetchCustomerEmails(
  accessToken: string,
  realmId: string,
  customerIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = uniq(customerIds);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const q = `SELECT * FROM Customer WHERE Id IN (${inList}) MAXRESULTS ${IN_CHUNK}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Customer"] ?? []) as QbCustomer[];
    for (const c of rows) {
      const email = c.PrimaryEmailAddr?.Address?.trim();
      if (c.Id && email) map.set(c.Id, email);
    }
  }
  return map;
}

/** Merge inherited deposit-line coding into an entity's detail + memo. */
function applyDepositCoding(
  detail: LineDetail,
  lineDescription: string | null,
  coding: DepositCoding | undefined,
): { detail: LineDetail; lineDescription: string | null } {
  if (!coding) return { detail, lineDescription };
  return {
    detail: {
      itemNames: detail.itemNames,
      accountNames: uniq([...detail.accountNames, ...coding.accountNames]),
      classes: uniq([...detail.classes, ...coding.classes]),
    },
    lineDescription: lineDescription ?? coding.memo,
  };
}

/**
 * Pull every incoming-money entity updated on/after `since` (or all, when
 * `since` is null). Returns normalized rows ready to stage.
 *
 * Strategy: collect the raw SalesReceipt / Payment / Deposit rows first, then
 * resolve the cross-references the coding depends on (linked-Invoice lines,
 * Item income accounts, Customer emails, and the Deposit→Payment/SalesReceipt
 * coding back-index), and only then build the normalized rows so every entity
 * carries its full coding.
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

  // ── Phase A: collect the raw rows. ──
  const salesReceipts: QbSalesReceipt[] = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM SalesReceipt${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["SalesReceipt"] ??
      []) as QbSalesReceipt[];
    salesReceipts.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

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

  const deposits: QbDeposit[] = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = `SELECT * FROM Deposit${whereClause}${orderClause} STARTPOSITION ${start} MAXRESULTS ${PAGE_SIZE}`;
    const resp = await runQuery(accessToken, realmId, q);
    const rows = (resp.QueryResponse?.["Deposit"] ?? []) as QbDeposit[];
    deposits.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }

  // ── Phase B: resolve cross-references the coding depends on. ──

  // Linked-invoice lines for invoice-applied Payments.
  const allInvoiceIds = uniq(payments.flatMap((p) => p.invoiceIds));
  const invoiceLines = allInvoiceIds.length
    ? await fetchInvoiceLines(accessToken, realmId, allInvoiceIds)
    : new Map<string, QbLine[]>();

  // Item income accounts for every item referenced by a SalesReceipt or an
  // invoice line (the revenue coding the classifier reads).
  const itemIds = uniq([
    ...salesReceipts.flatMap((r) => itemIdsFromLines(r.Line)),
    ...[...invoiceLines.values()].flatMap((lines) => itemIdsFromLines(lines)),
  ]);
  const itemAccounts = itemIds.length
    ? await fetchItemIncomeAccounts(accessToken, realmId, itemIds)
    : new Map<string, string>();

  // Deposit → Payment/SalesReceipt coding back-index: for each deposit LINE
  // that re-records an already-ingested Payment/SalesReceipt, capture the
  // posting account / class / memo so the underlying entity inherits it.
  const depositCodingByTxn = new Map<string, DepositCoding>();
  for (const dep of deposits) {
    for (const line of dep.Line ?? []) {
      const linked = (line.LinkedTxn ?? []).filter(
        (lt) => lt.TxnType === "Payment" || lt.TxnType === "SalesReceipt",
      );
      if (linked.length === 0) continue;
      const acct = line.DepositLineDetail?.AccountRef?.name;
      const cls = line.DepositLineDetail?.ClassRef?.name;
      const memo = line.Description ?? dep.PrivateNote ?? null;
      for (const lt of linked) {
        if (!lt.TxnId) continue;
        const key = `${lt.TxnType}:${lt.TxnId}`;
        const prev = depositCodingByTxn.get(key) ?? {
          accountNames: [],
          classes: [],
          memo: null,
          depositId: null,
        };
        depositCodingByTxn.set(key, {
          accountNames: uniq([...prev.accountNames, acct]),
          classes: uniq([...prev.classes, cls]),
          memo: prev.memo ?? memo,
          // First deposit wins; an entity normally belongs to exactly one.
          depositId: prev.depositId ?? dep.Id,
        });
      }
    }
  }

  // Customer emails to enrich payers that carry no email of their own.
  const customerIds = uniq([
    ...salesReceipts.map((r) => r.CustomerRef?.value),
    ...payments.map((p) => p.row.CustomerRef?.value),
    ...deposits.flatMap((dep) =>
      (dep.Line ?? []).map((l) => l.DepositLineDetail?.Entity?.value),
    ),
  ]);
  const customerEmails = customerIds.length
    ? await fetchCustomerEmails(accessToken, realmId, customerIds)
    : new Map<string, string>();

  // ── Phase C: build the normalized rows. ──
  const out: NormalizedQuickbooksPayment[] = [];

  // SalesReceipt — carries its own item lines; income account resolved via the
  // item map. Inherit any deposit-line coding that re-recorded it.
  for (const row of salesReceipts) {
    const ownDetail = extractLineDetail(row.Line, itemAccounts);
    const coding = depositCodingByTxn.get(`SalesReceipt:${row.Id}`);
    const { detail, lineDescription } = applyDepositCoding(
      ownDetail,
      row.CustomerMemo?.value ?? null,
      coding,
    );
    out.push({
      qbEntityType: "sales_receipt",
      qbEntityId: row.Id,
      qbLineId: "",
      qbDepositId: coding?.depositId ?? null,
      amount: num(row.TotalAmt),
      dateReceived: row.TxnDate ?? null,
      payerName: row.CustomerRef?.name ?? null,
      payerEmail:
        row.BillEmail?.Address ??
        (row.CustomerRef?.value
          ? (customerEmails.get(row.CustomerRef.value) ?? null)
          : null),
      rawReference: row.DocNumber ?? row.CustomerMemo?.value ?? null,
      lineDescription,
      lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
      lineItemNames: detail.itemNames,
      lineAccountNames: detail.accountNames,
      lineClasses: detail.classes,
      qbPayerType: row.CustomerRef ? "customer" : null,
      qbPayerId: row.CustomerRef?.value ?? null,
      qbPaymentMethod: row.PaymentMethodRef?.name ?? null,
      qbCheckNumber: row.PaymentRefNum ?? null,
      qbDepositToAccountName: row.DepositToAccountRef?.name ?? null,
      qbDocNumber: row.DocNumber ?? null,
      qbBillingAddress: flattenAddr(row.BillAddr),
      qbTransactionMemo: row.PrivateNote ?? null,
      qbCurrency: row.CurrencyRef?.value ?? null,
      qbExchangeRate: rate(row.ExchangeRate),
      qbCreateTime: row.MetaData?.CreateTime ?? null,
      qbLinkedTxn: mapLinkedTxn(
        (row.Line ?? []).flatMap((l) => l.LinkedTxn ?? []),
      ),
      qbRaw: row,
      qbRawLine: null,
    });
  }

  // Payment — no lines of its own. Coding comes from the linked Invoice(s)
  // (item income accounts) and, for uninvoiced payments later deposited, the
  // Deposit line that re-recorded it.
  for (const { row, invoiceIds } of payments) {
    const invDetail = mergeLineDetail(
      invoiceIds.map((id) => extractLineDetail(invoiceLines.get(id), itemAccounts)),
    );
    const coding = depositCodingByTxn.get(`Payment:${row.Id}`);
    const { detail, lineDescription } = applyDepositCoding(
      invDetail,
      null,
      coding,
    );
    out.push({
      qbEntityType: "payment",
      qbEntityId: row.Id,
      qbLineId: "",
      qbDepositId: coding?.depositId ?? null,
      amount: num(row.TotalAmt),
      dateReceived: row.TxnDate ?? null,
      payerName: row.CustomerRef?.name ?? null,
      payerEmail: row.CustomerRef?.value
        ? (customerEmails.get(row.CustomerRef.value) ?? null)
        : null,
      rawReference: row.PaymentRefNum ?? null,
      lineDescription,
      lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
      lineItemNames: detail.itemNames,
      lineAccountNames: detail.accountNames,
      lineClasses: detail.classes,
      qbPayerType: row.CustomerRef ? "customer" : null,
      qbPayerId: row.CustomerRef?.value ?? null,
      qbPaymentMethod: row.PaymentMethodRef?.name ?? null,
      qbCheckNumber: row.PaymentRefNum ?? null,
      qbDepositToAccountName: row.DepositToAccountRef?.name ?? null,
      qbDocNumber: row.DocNumber ?? null,
      qbBillingAddress: null,
      qbTransactionMemo: row.PrivateNote ?? null,
      qbCurrency: row.CurrencyRef?.value ?? null,
      qbExchangeRate: rate(row.ExchangeRate),
      qbCreateTime: row.MetaData?.CreateTime ?? null,
      qbLinkedTxn: mapLinkedTxn(
        (row.Line ?? []).flatMap((l) => l.LinkedTxn ?? []),
      ),
      qbRaw: row,
      qbRawLine: null,
    });
  }

  // Deposit — a bank deposit bundles MANY donors, one per line, each with its
  // own payer (DepositLineDetail.Entity), amount and description. So we stage
  // PER LINE, not per deposit. Lines that merely re-record an already-ingested
  // Payment/SalesReceipt (LinkedTxn present) are SKIPPED so the same money is
  // never staged twice (their coding was already folded into that entity above
  // via depositCodingByTxn).
  for (const row of deposits) {
    const depositMemo = row.PrivateNote ?? null;
    for (const line of row.Line ?? []) {
      // Skip ONLY lines that link back to a Payment/SalesReceipt — that money
      // is ingested via its own entity, so staging the deposit line too would
      // double-count it. Lines linked to other txn types (e.g. transfers,
      // journal entries) are NOT a duplicate of an ingested unit, so they are
      // still staged as their own direct deposit line.
      if (
        (line.LinkedTxn ?? []).some(
          (lt) => lt.TxnType === "Payment" || lt.TxnType === "SalesReceipt",
        )
      )
        continue;
      // Each direct deposit line is its own matching unit.
      const detail = extractLineDetail([line], itemAccounts);
      const entityId = line.DepositLineDetail?.Entity?.value ?? null;
      out.push({
        qbEntityType: "deposit",
        qbEntityId: row.Id,
        qbLineId: line.Id ?? "",
        // A direct deposit line's underlying deposit is the deposit itself.
        qbDepositId: row.Id,
        amount: num(line.Amount),
        dateReceived: row.TxnDate ?? null,
        // The payer for a direct deposit line is its Entity (Customer /
        // Vendor / Employee ref); null when QuickBooks recorded none.
        payerName: line.DepositLineDetail?.Entity?.name ?? null,
        payerEmail: entityId ? (customerEmails.get(entityId) ?? null) : null,
        // Deposit memo (PrivateNote) for context; falls back to the bank
        // account when there is no memo.
        rawReference: depositMemo ?? row.DepositToAccountRef?.name ?? null,
        // The per-line description carries the most specific free text
        // (often the donor name or gift note) — used by the memo matcher.
        lineDescription: line.Description ?? null,
        lastUpdatedTime: row.MetaData?.LastUpdatedTime ?? null,
        lineItemNames: detail.itemNames,
        lineAccountNames: detail.accountNames,
        lineClasses: detail.classes,
        // The deposit line's Entity ref carries the payer kind + id.
        qbPayerType: normalizePayerType(line.DepositLineDetail?.Entity?.type),
        qbPayerId: entityId,
        // Payment method / check number live on the deposit LINE detail.
        qbPaymentMethod: line.DepositLineDetail?.PaymentMethodRef?.name ?? null,
        qbCheckNumber: line.DepositLineDetail?.CheckNum ?? null,
        // The deposit's destination bank account.
        qbDepositToAccountName: row.DepositToAccountRef?.name ?? null,
        qbDocNumber: row.DocNumber ?? null,
        qbBillingAddress: null,
        // The deposit's transaction-level memo (distinct from the line note).
        qbTransactionMemo: depositMemo,
        qbCurrency: row.CurrencyRef?.value ?? null,
        qbExchangeRate: rate(row.ExchangeRate),
        qbCreateTime: row.MetaData?.CreateTime ?? null,
        qbLinkedTxn: mapLinkedTxn(line.LinkedTxn),
        // Store the whole deposit as the raw entity AND the specific line.
        qbRaw: row,
        qbRawLine: line,
      });
    }
  }

  return out;
}
