-- Migration 0058: Reconciler gift final-amount provenance (Phase D/E)
--
-- Makes the CRM gift the single source of truth for a money event while keeping
-- it tied PERMANENTLY to its reconciliation evidence (a Stripe charge or a
-- QuickBooks staged row) WITHOUT that evidence ever becoming a second gift.
--
-- Ships:
--   1. enum gift_final_amount_source ('human' | 'stripe' | 'quickbooks')
--   2. gifts_and_payments provenance columns:
--        original_human_crm_amount     numeric(14,2)   (snapshot of human amount)
--        final_amount_source           NOT NULL DEFAULT 'human'
--        final_amount_stripe_charge_id text  FK -> stripe_staged_charges RESTRICT
--        final_amount_qb_staged_payment_id text FK -> staged_payments  RESTRICT
--   3. source<->pointer XOR CHECK (human => no ptr; stripe => stripe ptr only;
--      quickbooks => qb ptr only)
--   4. two partial-UNIQUE indexes (one evidence row backs AT MOST ONE gift)
--   5. gift_amount_allocation_review worklist table (allocations that couldn't be
--      auto-rebalanced after a stamp)
--   6. a SCOPED, IDEMPOTENT backfill: snapshot original_human_crm_amount = amount
--      for every pre-existing (still-human, un-stamped) gift.
--
-- RUN AS A SINGLE TRANSACTION:
--
--     psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0058_reconciler_gift_provenance.sql
--
-- ORDERING vs 0057: independent — 0058 does NOT use the staged_payment_status
-- 'reconciled' value, so it may run before OR after 0057. (Rows are marked
-- 'reconciled' only later, at confirm time, by the application.)
--
-- ORDERING vs Publish: either order is safe. Every DDL statement is guarded
-- (IF NOT EXISTS / catalog look-ups), so if the normal Drizzle schema diff on
-- Publish already created the columns / FKs / CHECK / indexes / table, this file
-- is a no-op for them. Publish ships SCHEMA ONLY — it does NOT run the step-6
-- data backfill, so a human MUST run this file regardless of Publish to snapshot
-- original_human_crm_amount.
--
-- LOCKING NOTE: the ADD COLUMN ... NOT NULL DEFAULT 'human' and the ADD
-- CONSTRAINT ... CHECK / FOREIGN KEY each take a brief ACCESS EXCLUSIVE lock and
-- the CHECK/FK validate existing rows. On the current gifts_and_payments size
-- this is sub-second; run during a quiet window to be safe. CREATE INDEX here is
-- plain (not CONCURRENTLY) because it runs inside the single transaction.
--
-- IDEMPOTENT: safe to re-run; guards make every step a no-op once applied.

-- 1. enum ----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gift_final_amount_source') THEN
    CREATE TYPE gift_final_amount_source AS ENUM ('human', 'stripe', 'quickbooks');
  END IF;
END $$;

-- 2. provenance columns --------------------------------------------------------
ALTER TABLE public.gifts_and_payments
  ADD COLUMN IF NOT EXISTS original_human_crm_amount numeric(14, 2);

ALTER TABLE public.gifts_and_payments
  ADD COLUMN IF NOT EXISTS final_amount_source gift_final_amount_source
    NOT NULL DEFAULT 'human';

ALTER TABLE public.gifts_and_payments
  ADD COLUMN IF NOT EXISTS final_amount_stripe_charge_id text;

ALTER TABLE public.gifts_and_payments
  ADD COLUMN IF NOT EXISTS final_amount_qb_staged_payment_id text;

-- FK -> stripe_staged_charges (RESTRICT). Guard by ANY existing FK on the column
-- (not by name) so a Publish-created FK with the same Drizzle-truncated name is
-- not duplicated. The explicit name matches Drizzle's generated (63-char
-- truncated) name so a later Publish diff sees it as already-present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.gifts_and_payments'::regclass
      AND c.contype = 'f'
      AND a.attname = 'final_amount_stripe_charge_id'
  ) THEN
    ALTER TABLE public.gifts_and_payments
      ADD CONSTRAINT gifts_and_payments_final_amount_stripe_charge_id_stripe_staged_
      FOREIGN KEY (final_amount_stripe_charge_id)
      REFERENCES public.stripe_staged_charges (id) ON DELETE RESTRICT;
  END IF;
END $$;

-- FK -> staged_payments (RESTRICT).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.gifts_and_payments'::regclass
      AND c.contype = 'f'
      AND a.attname = 'final_amount_qb_staged_payment_id'
  ) THEN
    ALTER TABLE public.gifts_and_payments
      ADD CONSTRAINT gifts_and_payments_final_amount_qb_staged_payment_id_staged_pay
      FOREIGN KEY (final_amount_qb_staged_payment_id)
      REFERENCES public.staged_payments (id) ON DELETE RESTRICT;
  END IF;
END $$;

-- 3. source<->pointer XOR CHECK ------------------------------------------------
-- All pre-existing rows are source='human' with both pointers NULL (the columns
-- were just added), so the constraint validates immediately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'gifts_and_payments_final_amount_source_ptr'
      AND conrelid = 'public.gifts_and_payments'::regclass
  ) THEN
    ALTER TABLE public.gifts_and_payments
      ADD CONSTRAINT gifts_and_payments_final_amount_source_ptr CHECK (
        (final_amount_source = 'human'
          AND final_amount_stripe_charge_id IS NULL
          AND final_amount_qb_staged_payment_id IS NULL)
        OR (final_amount_source = 'stripe'
          AND final_amount_stripe_charge_id IS NOT NULL
          AND final_amount_qb_staged_payment_id IS NULL)
        OR (final_amount_source = 'quickbooks'
          AND final_amount_qb_staged_payment_id IS NOT NULL
          AND final_amount_stripe_charge_id IS NULL)
      );
  END IF;
END $$;

-- 4. partial-UNIQUE pointer indexes --------------------------------------------
-- One Stripe charge / QB staged row is the final-amount source for AT MOST ONE
-- gift. WHERE ... IS NOT NULL leaves the many un-stamped human gifts (pointer
-- NULL) unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS gifts_and_payments_final_amount_stripe_charge_id_idx
  ON public.gifts_and_payments (final_amount_stripe_charge_id)
  WHERE final_amount_stripe_charge_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS gifts_and_payments_final_amount_qb_staged_payment_id_idx
  ON public.gifts_and_payments (final_amount_qb_staged_payment_id)
  WHERE final_amount_qb_staged_payment_id IS NOT NULL;

-- 5. gift_amount_allocation_review worklist ------------------------------------
-- Gifts whose `amount` was overwritten by a stamp but whose allocations could
-- NOT be auto-rebalanced (0 allocations, or 2+ whose split no longer sums). At
-- most one OPEN row per gift (partial-unique WHERE resolved_at IS NULL).
CREATE TABLE IF NOT EXISTS public.gift_amount_allocation_review (
  id text NOT NULL,
  gift_id text NOT NULL,
  source gift_final_amount_source NOT NULL,
  old_amount numeric(14, 2),
  new_amount numeric(14, 2),
  allocation_count integer NOT NULL,
  reason text NOT NULL,
  resolved_at timestamp,
  resolved_by_user_id text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT gift_amount_allocation_review_pkey PRIMARY KEY (id),
  CONSTRAINT gift_amount_allocation_review_gift_id_gifts_and_payments_id_fk
    FOREIGN KEY (gift_id)
    REFERENCES public.gifts_and_payments (id) ON DELETE CASCADE,
  CONSTRAINT gift_amount_allocation_review_resolved_by_user_id_users_id_fk
    FOREIGN KEY (resolved_by_user_id)
    REFERENCES public.users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS gift_amount_allocation_review_gift_id_idx
  ON public.gift_amount_allocation_review (gift_id);
CREATE INDEX IF NOT EXISTS gift_amount_allocation_review_resolved_at_idx
  ON public.gift_amount_allocation_review (resolved_at);
CREATE UNIQUE INDEX IF NOT EXISTS gift_amount_allocation_review_open_gift_uq
  ON public.gift_amount_allocation_review (gift_id)
  WHERE resolved_at IS NULL;

-- 6. scoped, idempotent backfill (DATA — not shipped by Publish) ---------------
-- Snapshot the human-entered amount for every pre-existing gift that has NOT yet
-- been stamped by a processor. Re-running is a no-op: once
-- original_human_crm_amount is set the row drops out of the WHERE. Stamped
-- (stripe/quickbooks) gifts are excluded — their snapshot is taken at stamp time.
UPDATE public.gifts_and_payments
SET original_human_crm_amount = amount
WHERE original_human_crm_amount IS NULL
  AND final_amount_source = 'human'
  AND final_amount_stripe_charge_id IS NULL
  AND final_amount_qb_staged_payment_id IS NULL;

-- Verification:
--   SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
--    WHERE t.typname = 'gift_final_amount_source' ORDER BY e.enumsortorder;
--   SELECT count(*) AS unsnapshotted FROM gifts_and_payments
--    WHERE original_human_crm_amount IS NULL AND final_amount_source = 'human';
--   -- expect 0
--   SELECT to_regclass('public.gift_amount_allocation_review') IS NOT NULL;
