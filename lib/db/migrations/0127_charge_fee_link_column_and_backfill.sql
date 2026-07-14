-- 0127: Charge → QuickBooks "Stripe fee" row link (plane-1 settlement
-- evidence) + backfill for already-confirmed charge ties.
--
-- WHAT: adds stripe_staged_charges.linked_fee_qb_staged_payment_id — the
-- sibling NEGATIVE "Stripe fee" line of the SAME QB deposit as the tied donor
-- line, auto-detected when a charge↔QB tie is confirmed. The fee row is
-- thereby accounted for WITHOUT ever entering payment_applications (fees stay
-- out of plane 2 by design — intentional and permanent per
-- docs/reconciliation-design.md).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraint, CREATE INDEX IF
-- NOT EXISTS; the backfill only fills NULL columns from unclaimed fee rows,
-- so a re-run finds nothing left to do. No BEGIN/COMMIT — apply with:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0127_charge_fee_link_column_and_backfill.sql
--
-- ORDER: apply AFTER Publish has shipped the schema (Publish also creates the
-- column/index by diffing the dev DB; every statement here is guarded either
-- way). The backfill is prod-data work Publish never does.

-- ── 1) Column ────────────────────────────────────────────────────────────
ALTER TABLE stripe_staged_charges
  ADD COLUMN IF NOT EXISTS linked_fee_qb_staged_payment_id text;

-- FK mirrors the drizzle-generated name (PG truncates to 63 chars, matching
-- the dev constraint exactly).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stripe_staged_charges_linked_fee_qb_staged_payment_id_staged_pa'
      AND conrelid = 'stripe_staged_charges'::regclass
  ) THEN
    ALTER TABLE stripe_staged_charges
      ADD CONSTRAINT stripe_staged_charges_linked_fee_qb_staged_payment_id_staged_payments_id_fk
      FOREIGN KEY (linked_fee_qb_staged_payment_id)
      REFERENCES staged_payments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- A QB fee row is settlement evidence for AT MOST ONE charge.
CREATE UNIQUE INDEX IF NOT EXISTS stripe_staged_charges_linked_fee_qb_staged_payment_id_uq
  ON stripe_staged_charges (linked_fee_qb_staged_payment_id)
  WHERE linked_fee_qb_staged_payment_id IS NOT NULL;

-- ── 2) Backfill: claim fee rows for ALREADY-CONFIRMED charge ties ────────
-- Mirrors the confirm-time auto-detection exactly:
--   • charge has a CONFIRMED donor-line tie (linked_qb_staged_payment_id),
--     no fee link yet, and a real fee (gross > net);
--   • candidate = NEGATIVE row of the SAME QB deposit (realm + entity type +
--     entity id) whose amount is exactly −(gross − net), with a fee-ish
--     payer/description, not itself donor-tied/proposed anywhere, not a
--     settlement-link deposit target, and not already claimed as a fee;
--   • duplicates (same deposit, same fee amount — e.g. two −13.11 lines)
--     pair greedily by rank: fee rows ordered by qb_line_id then id, charges
--     by id, joined rank-to-rank so each row is claimed at most once.
WITH tied AS (
  SELECT c.id AS charge_id,
         sp.realm_id, sp.qb_entity_type, sp.qb_entity_id,
         round(c.gross_amount::numeric - c.net_amount::numeric, 2) AS fee_amt
  FROM stripe_staged_charges c
  JOIN staged_payments sp ON sp.id = c.linked_qb_staged_payment_id
  WHERE c.linked_qb_staged_payment_id IS NOT NULL
    AND c.linked_fee_qb_staged_payment_id IS NULL
    AND c.gross_amount IS NOT NULL
    AND c.net_amount IS NOT NULL
    AND c.gross_amount::numeric > c.net_amount::numeric
),
fee_candidates AS (
  SELECT f.id AS fee_id,
         f.realm_id, f.qb_entity_type, f.qb_entity_id,
         round(-f.amount::numeric, 2) AS fee_amt,
         f.qb_line_id
  FROM staged_payments f
  WHERE f.amount::numeric < 0
    AND (f.payer_name ILIKE '%stripe%'
         OR f.line_description ILIKE '%stripe%'
         OR f.line_description ILIKE '%fee%')
    AND NOT EXISTS (SELECT 1 FROM stripe_staged_charges x
                    WHERE x.linked_fee_qb_staged_payment_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM stripe_staged_charges x
                    WHERE x.linked_qb_staged_payment_id = f.id
                       OR x.proposed_qb_staged_payment_id = f.id)
    AND NOT EXISTS (SELECT 1 FROM settlement_links sl
                    WHERE sl.deposit_staged_payment_id = f.id)
),
ranked_charges AS (
  SELECT t.*,
         row_number() OVER (
           PARTITION BY t.realm_id, t.qb_entity_type, t.qb_entity_id, t.fee_amt
           ORDER BY t.charge_id
         ) AS rn
  FROM tied t
),
ranked_fees AS (
  SELECT fc.*,
         row_number() OVER (
           PARTITION BY fc.realm_id, fc.qb_entity_type, fc.qb_entity_id, fc.fee_amt
           ORDER BY fc.qb_line_id, fc.fee_id
         ) AS rn
  FROM fee_candidates fc
),
pairs AS (
  SELECT rc.charge_id, rf.fee_id
  FROM ranked_charges rc
  JOIN ranked_fees rf
    ON rf.realm_id = rc.realm_id
   AND rf.qb_entity_type = rc.qb_entity_type
   AND rf.qb_entity_id = rc.qb_entity_id
   AND rf.fee_amt = rc.fee_amt
   AND rf.rn = rc.rn
)
UPDATE stripe_staged_charges c
SET linked_fee_qb_staged_payment_id = p.fee_id,
    updated_at = now()
FROM pairs p
WHERE c.id = p.charge_id
  AND c.linked_fee_qb_staged_payment_id IS NULL;

-- Verification (run after):
--   SELECT count(*) AS fee_linked
--   FROM stripe_staged_charges
--   WHERE linked_fee_qb_staged_payment_id IS NOT NULL;
-- Expect > 0 only if confirmed charge ties with matching sibling fee rows
-- exist; judge by the affected-row count of the UPDATE, not a clean exit.
