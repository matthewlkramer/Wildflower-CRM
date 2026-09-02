-- 0226: durable import receipts for scheduled QuickBooks banking reports.
--
-- YTD reports intentionally repeat every prior transaction. bank_transactions
-- deduplicates those evidence rows, while this table separately records that a
-- new report was received and processed successfully. The reconciliation-page
-- freshness note can therefore advance even on a day with no new deposits.
-- Idempotent and safe to re-run.

CREATE TABLE IF NOT EXISTS bank_transaction_imports (
  id text PRIMARY KEY,
  source bank_transaction_source NOT NULL,
  source_file text NOT NULL,
  mailbox_user_id text REFERENCES users(id) ON DELETE SET NULL,
  gmail_message_id text,
  gmail_attachment_id text,
  content_sha256 text NOT NULL,
  report_start_date date,
  report_end_date date,
  row_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  error text,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_transaction_imports_status_chk
    CHECK (status IN ('succeeded', 'rejected')),
  CONSTRAINT bank_transaction_imports_counts_chk
    CHECK (row_count >= 0 AND inserted_count >= 0 AND inserted_count <= row_count)
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_transaction_imports_gmail_attachment_uq
  ON bank_transaction_imports (mailbox_user_id, gmail_message_id, gmail_attachment_id)
  WHERE mailbox_user_id IS NOT NULL
    AND gmail_message_id IS NOT NULL
    AND gmail_attachment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bank_transaction_imports_source_processed_idx
  ON bank_transaction_imports (source, processed_at);
