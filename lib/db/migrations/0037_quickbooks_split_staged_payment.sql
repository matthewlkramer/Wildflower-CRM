-- 0037_quickbooks_split_staged_payment.sql
--
-- Adds the child table that backs SPLIT reconciliation in the staged-payments
-- reconciler: ONE QuickBooks staged payment (typically a Stripe payout that nets
-- fees and deposits a lump sum) reconciled across TWO OR MORE pre-existing CRM
-- gifts, each link carrying that gift's own gross amount (sub_amount). No new
-- gift is minted; the staged row's own donor / single-gift link columns are
-- cleared and its resolution lives entirely in this table.
--
--   * staged_payment_id   — the split parent (FK → staged_payments, ON DELETE
--                           CASCADE: a split link is meaningless without it;
--                           reverting the staged row deletes its split rows).
--   * gift_id             — the pre-existing gift this portion links to (FK →
--                           gifts_and_payments, ON DELETE RESTRICT: a split link
--                           is a money-trail reference, so a gift must be
--                           unsplit before it can be deleted).
--   * sub_amount          — the portion attributed to this gift = the gift's own
--                           gross amount at split time.
--   * created_by_user_id  — who performed the split (FK → users, ON DELETE SET
--                           NULL).
--
-- A gift may be the target of AT MOST ONE split link (unique index on gift_id),
-- mirroring the one-staged↔one-gift partial-unique indexes on
-- staged_payments.matched_gift_id / created_gift_id. Combined with the split
-- route's cross-link guard, a gift is "taken" once it is matched, created,
-- group-reconciled, OR split-linked, and cannot be claimed twice.
--
-- Publish applies table/column/index/constraint diffs but NEVER `CREATE
-- EXTENSION`; this file uses only plain table/columns/indexes/FKs, so it simply
-- mirrors what Publish would do, made fully idempotent so a human can run it by
-- hand on prod first.
--
-- Idempotent and additive (safe to re-run). No existing data is rewritten — the
-- table is created empty.

CREATE TABLE IF NOT EXISTS staged_payment_splits (
  id text PRIMARY KEY,
  staged_payment_id text NOT NULL,
  gift_id text NOT NULL,
  sub_amount numeric(14, 2) NOT NULL,
  created_by_user_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- FK → staged_payments (ON DELETE CASCADE).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'staged_payment_splits'::regclass
      AND contype = 'f'
      AND conname LIKE 'staged_payment_splits_staged_payment_id%'
  ) THEN
    ALTER TABLE staged_payment_splits
      ADD CONSTRAINT staged_payment_splits_staged_payment_id_fk
      FOREIGN KEY (staged_payment_id)
      REFERENCES staged_payments (id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- FK → gifts_and_payments (ON DELETE RESTRICT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'staged_payment_splits'::regclass
      AND contype = 'f'
      AND conname LIKE 'staged_payment_splits_gift_id%'
  ) THEN
    ALTER TABLE staged_payment_splits
      ADD CONSTRAINT staged_payment_splits_gift_id_fk
      FOREIGN KEY (gift_id)
      REFERENCES gifts_and_payments (id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

-- FK → users (ON DELETE SET NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'staged_payment_splits'::regclass
      AND contype = 'f'
      AND conname LIKE 'staged_payment_splits_created_by_user_id%'
  ) THEN
    ALTER TABLE staged_payment_splits
      ADD CONSTRAINT staged_payment_splits_created_by_user_id_fk
      FOREIGN KEY (created_by_user_id)
      REFERENCES users (id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- A gift can be split-linked at most once (no double counting).
CREATE UNIQUE INDEX IF NOT EXISTS staged_payment_splits_gift_id_uq
  ON staged_payment_splits (gift_id);

-- Look up the members of a staged row's split.
CREATE INDEX IF NOT EXISTS staged_payment_splits_staged_payment_id_idx
  ON staged_payment_splits (staged_payment_id);
