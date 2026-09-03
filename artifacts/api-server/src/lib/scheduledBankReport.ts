import { createHash } from "node:crypto";
import {
  BANK_REPORT_FILENAME_RE,
  mergeWellsFargoTransactions,
  parseBankingTransactionsReportFile,
  toIsoDate,
  toNumeric,
  wellsFargoId,
  WELLS_FARGO_SOURCE,
} from "@workspace/bank-reports";
import { pool } from "@workspace/db";
import { extractMessageParts, getAttachmentBytes, getMessage } from "./gmail";
import { recomputeBankSpineBestEffort } from "./bankSpineRecompute";
import { logger } from "./logger";

export const SCHEDULED_BANK_REPORT_MAILBOX =
  "matthew.kramer@wildflowerschools.org";

const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const BATCH_SIZE = 250;
const IMPORT_LOCK_KEY = 7_341_894_526;

function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

function isIntuitDomain(domain: string): boolean {
  return domain === "intuit.com" || domain.endsWith(".intuit.com");
}

export interface ScheduledBankReportMetadata {
  mailboxEmail: string;
  fromAddresses: string[];
  toAddresses: string[];
}

/** Metadata-only gate before Gmail downloads any attachment bytes. */
export function isScheduledBankReportEmail(
  input: ScheduledBankReportMetadata,
): boolean {
  const mailbox = input.mailboxEmail.trim().toLowerCase();
  if (mailbox !== SCHEDULED_BANK_REPORT_MAILBOX) return false;
  if (!input.toAddresses.some((address) => address.toLowerCase() === mailbox)) {
    return false;
  }
  if (
    !input.fromAddresses.some((address) => isIntuitDomain(emailDomain(address)))
  ) {
    return false;
  }
  // QuickBooks lets the scheduler owner choose an arbitrary subject. The
  // attachment filename and content validator below are the narrow report
  // discriminator; do not make delivery depend on mutable subject text.
  return true;
}

export function isScheduledBankReportAttachment(filename: string): boolean {
  return BANK_REPORT_FILENAME_RE.test(filename.trim());
}

export interface ScheduledBankReportAttachmentInput {
  mailboxUserId: string;
  gmailMessageId: string;
  gmailAttachmentId: string;
  filename: string;
  bytes: Buffer;
}

export interface ManualBankReportFileInput {
  filename: string;
  bytes: Buffer;
}

export interface ScheduledBankReportImportResult {
  status: "succeeded" | "rejected";
  rowsSeen: number;
  rowsInserted: number;
  alreadyProcessed: boolean;
  error?: string;
}

export interface ScheduledBankReportMessageResult {
  status: "succeeded" | "rejected" | "not_report";
  attachmentBytes: number;
}

interface BankReportImportInput {
  id: string;
  mailboxUserId: string | null;
  gmailMessageId: string | null;
  gmailAttachmentId: string | null;
  filename: string;
  bytes: Buffer;
}

function scheduledImportId(input: ScheduledBankReportAttachmentInput): string {
  return `bti_${createHash("sha256")
    .update(
      `${input.mailboxUserId}|${input.gmailMessageId}|${input.gmailAttachmentId}`,
    )
    .digest("hex")
    .slice(0, 24)}`;
}

function contentHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable receipt identity for a manually uploaded file; never invent Gmail provenance. */
export function manualBankReportImportId(bytes: Buffer): string {
  return `bti_manual_${contentHash(bytes).slice(0, 24)}`;
}

async function recordRejected(
  input: BankReportImportInput,
  sha256: string,
  error: string,
): Promise<ScheduledBankReportImportResult> {
  await pool.query(
    `INSERT INTO bank_transaction_imports (
       id, source, source_file, mailbox_user_id, gmail_message_id,
       gmail_attachment_id, content_sha256, row_count, inserted_count,
       status, error, processed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 'rejected', $8, now())
     ON CONFLICT (id) DO UPDATE SET
       source_file = EXCLUDED.source_file,
       content_sha256 = EXCLUDED.content_sha256,
       row_count = 0,
       inserted_count = 0,
       status = 'rejected',
       error = EXCLUDED.error,
       processed_at = now()`,
    [
      input.id,
      WELLS_FARGO_SOURCE,
      input.filename,
      input.mailboxUserId,
      input.gmailMessageId,
      input.gmailAttachmentId,
      sha256,
      error.slice(0, 2_000),
    ],
  );
  return {
    status: "rejected",
    rowsSeen: 0,
    rowsInserted: 0,
    alreadyProcessed: false,
    error,
  };
}

/**
 * Import one trusted attachment. YTD overlap is harmless: stable physical-bank
 * facts own the unique key, while Payee / Category / account are refreshed as
 * mutable annotations when QuickBooks changes them later.
 */
export async function importScheduledBankReportAttachment(
  input: ScheduledBankReportAttachmentInput,
): Promise<ScheduledBankReportImportResult> {
  return importBankReportFile({
    ...input,
    id: scheduledImportId(input),
  });
}

async function importBankReportFile(
  input: BankReportImportInput,
): Promise<ScheduledBankReportImportResult> {
  const id = input.id;
  const sha256 = contentHash(input.bytes);
  if (!isScheduledBankReportAttachment(input.filename)) {
    return recordRejected(input, sha256, "Unexpected attachment filename");
  }
  if (input.bytes.length > MAX_REPORT_BYTES) {
    return recordRejected(
      input,
      sha256,
      `Attachment exceeds ${MAX_REPORT_BYTES} byte limit`,
    );
  }

  let parsed: ReturnType<typeof parseBankingTransactionsReportFile>;
  try {
    parsed = parseBankingTransactionsReportFile(input.bytes, input.filename);
  } catch (error) {
    return recordRejected(
      input,
      sha256,
      error instanceof Error ? error.message : String(error),
    );
  }
  const merged = mergeWellsFargoTransactions(parsed.rows);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [IMPORT_LOCK_KEY]);
    const prior = await client.query<{ status: string }>(
      "SELECT status FROM bank_transaction_imports WHERE id = $1",
      [id],
    );
    if (prior.rows[0]?.status === "succeeded") {
      await client.query("COMMIT");
      return {
        status: "succeeded",
        rowsSeen: merged.length,
        rowsInserted: 0,
        alreadyProcessed: true,
      };
    }

    let inserted = 0;
    for (let i = 0; i < merged.length; i += BATCH_SIZE) {
      const batch = merged.slice(i, i + BATCH_SIZE);
      const params: (string | number | null)[] = [];
      const tuples = batch.map(({ row, dedupKey, occurrence }, index) => {
        params.push(
          wellsFargoId(dedupKey, occurrence),
          WELLS_FARGO_SOURCE,
          row.file,
          toIsoDate(row.date),
          row.received ? "deposit" : "payment",
          row.checkNo || null,
          row.fromTo || null,
          row.description || null,
          null,
          row.account || null,
          null,
          null,
          null,
          toNumeric(row.spent),
          toNumeric(row.received),
          null,
          row.qbPosting || null,
          row.donor || null,
          dedupKey,
          occurrence,
        );
        const start = index * 20;
        return `(${Array.from({ length: 20 }, (_, column) => `$${start + column + 1}`).join(", ")})`;
      });
      const insertResult = await client.query(
        `INSERT INTO bank_transactions (
           id, source, source_file, txn_date, txn_type, ref_no, payee, memo,
           class, account, location, reconciliation_status, added_in_banking,
           payment, deposit, balance, qb_posting, donor, dedup_key, occurrence
         ) VALUES ${tuples.join(", ")}
         ON CONFLICT (source, dedup_key, occurrence) DO NOTHING`,
        params,
      );
      inserted += insertResult.rowCount ?? 0;

      const annotationParams: (string | number | null)[] = [];
      const annotationRows = batch.map(
        ({ row, dedupKey, occurrence }, index) => {
          annotationParams.push(
            dedupKey,
            occurrence,
            row.file,
            row.fromTo || null,
            row.account || null,
            row.qbPosting || null,
            row.donor || null,
          );
          const start = index * 7;
          return `($${start + 1}::text, $${start + 2}::integer, $${start + 3}::text, $${start + 4}::text, $${start + 5}::text, $${start + 6}::text, $${start + 7}::text)`;
        },
      );
      await client.query(
        `UPDATE bank_transactions bt
         SET source_file = incoming.source_file,
             payee = COALESCE(incoming.payee, bt.payee),
             account = COALESCE(incoming.account, bt.account),
             qb_posting = COALESCE(incoming.qb_posting, bt.qb_posting),
             donor = COALESCE(incoming.donor, bt.donor)
         FROM (VALUES ${annotationRows.join(", ")}) AS incoming(
           dedup_key, occurrence, source_file, payee, account, qb_posting, donor
         )
         WHERE bt.source = '${WELLS_FARGO_SOURCE}'
           AND bt.dedup_key = incoming.dedup_key
           AND bt.occurrence = incoming.occurrence`,
        annotationParams,
      );
    }

    await client.query(
      `INSERT INTO bank_transaction_imports (
         id, source, source_file, mailbox_user_id, gmail_message_id,
         gmail_attachment_id, content_sha256, report_start_date,
         report_end_date, row_count, inserted_count, status, error,
         processed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'succeeded', NULL, now())
       ON CONFLICT (id) DO UPDATE SET
         source_file = EXCLUDED.source_file,
         content_sha256 = EXCLUDED.content_sha256,
         report_start_date = EXCLUDED.report_start_date,
         report_end_date = EXCLUDED.report_end_date,
         row_count = EXCLUDED.row_count,
         inserted_count = EXCLUDED.inserted_count,
         status = 'succeeded',
         error = NULL,
         processed_at = now()`,
      [
        id,
        WELLS_FARGO_SOURCE,
        input.filename,
        input.mailboxUserId,
        input.gmailMessageId,
        input.gmailAttachmentId,
        sha256,
        parsed.reportStartDate,
        parsed.reportEndDate,
        merged.length,
        inserted,
      ],
    );
    await client.query("COMMIT");
    return {
      status: "succeeded",
      rowsSeen: merged.length,
      rowsInserted: inserted,
      alreadyProcessed: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function processBankReportFile(
  input: BankReportImportInput,
): Promise<ScheduledBankReportImportResult> {
  const imported = await importBankReportFile(input);
  if (imported.status === "succeeded") {
    await recomputeBankSpineBestEffort();
  }
  return imported;
}

/**
 * Manual fallback for a finance user who has the same QuickBooks YTD report
 * before the scheduled Gmail delivery arrives. The parser, idempotent evidence
 * transaction, receipt, and bank-spine recomputation are identical to the
 * scheduled path; only the optional Gmail provenance is absent.
 */
export async function processManualBankReportFile(
  input: ManualBankReportFileInput,
): Promise<ScheduledBankReportImportResult> {
  return processBankReportFile({
    id: manualBankReportImportId(input.bytes),
    mailboxUserId: null,
    gmailMessageId: null,
    gmailAttachmentId: null,
    filename: input.filename,
    bytes: input.bytes,
  });
}

/**
 * Fetch, validate, and import one metadata-gated Gmail message. Gmail/network
 * and database failures deliberately bubble so the mailbox cursor retries;
 * permanent content/shape rejections return normally so one bad report cannot
 * pin the entire mailbox forever.
 */
export async function processScheduledBankReportMessage(input: {
  accessToken: string;
  mailboxUserId: string;
  gmailMessageId: string;
  subject: string | null;
}): Promise<ScheduledBankReportMessageResult> {
  const message = await getMessage(
    input.accessToken,
    input.gmailMessageId,
    "full",
  );
  const parts = extractMessageParts(message.payload);
  const attachments = parts.attachments.filter((attachment) =>
    isScheduledBankReportAttachment(attachment.filename),
  );
  if (attachments.length === 0) {
    logger.debug(
      {
        userId: input.mailboxUserId,
        gmailId: input.gmailMessageId,
        subject: input.subject,
      },
      "Intuit email did not contain the scheduled banking report",
    );
    return { status: "not_report", attachmentBytes: 0 };
  }
  if (attachments.length > 1) {
    logger.error(
      {
        userId: input.mailboxUserId,
        gmailId: input.gmailMessageId,
        subject: input.subject,
        matchingAttachmentCount: attachments.length,
        attachmentNames: parts.attachments.map((item) => item.filename),
      },
      "Scheduled bank report rejected: expected exactly one matching attachment",
    );
    return { status: "rejected", attachmentBytes: 0 };
  }

  const attachment = attachments[0];
  const bytes = await getAttachmentBytes(
    input.accessToken,
    input.gmailMessageId,
    attachment.attachmentId,
  );
  const scheduledInput = {
    mailboxUserId: input.mailboxUserId,
    gmailMessageId: input.gmailMessageId,
    gmailAttachmentId: attachment.attachmentId,
    filename: attachment.filename,
    bytes,
  };
  const imported = await processBankReportFile({
    ...scheduledInput,
    id: scheduledImportId(scheduledInput),
  });
  if (imported.status === "succeeded") {
    logger.info(
      {
        userId: input.mailboxUserId,
        gmailId: input.gmailMessageId,
        filename: attachment.filename,
        rowsSeen: imported.rowsSeen,
        rowsInserted: imported.rowsInserted,
        alreadyProcessed: imported.alreadyProcessed,
      },
      "Scheduled bank report imported",
    );
  } else {
    logger.error(
      {
        userId: input.mailboxUserId,
        gmailId: input.gmailMessageId,
        filename: attachment.filename,
        error: imported.error,
      },
      "Scheduled bank report rejected by content validation",
    );
  }
  return { status: imported.status, attachmentBytes: bytes.length };
}
