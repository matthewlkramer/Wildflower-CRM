-- Migration 0089: Plane 1 settlement-link table (Stripe payout <-> QB deposit).
--
-- WHY:
--   docs/reconciliation-design.md §4.3. Batch-to-batch *settlement* is structurally
--   different from the Plane-2 unit->gift cash-application ledger
--   (`payment_applications`): a settlement row has no donor and no amount split — it
--   only records "this Stripe payout landed as this QB deposit lump", plus a
--   confirmation lifecycle. `settlement_links` gives it a first-class home and
--   REPLACES the 7-value `stripe_payouts.qb_reconciliation_status` enum + its
--   pointer columns (`proposed/matched/qb_conflict_staged_payment_id`) + the
--   vestigial keep/replace/conflict paths. The payout's settlement status
--   (settled | proposed | orphan) becomes a pure derivation over this table (§4.4).
--
--   A confirmed link means the deposit and its constituent Stripe charges are the
--   SAME dollars at two grains. Avoiding a double count across that boundary is a
--   SEPARATE Plane-2 rule (§4.3 supersede: per-charge counted units downgrade the
--   coarse deposit->gift link to `corroborating`) — NOT modeled here; that is
--   Phase 5. Plane 1 only records the confirmed tie.
--
-- WHAT THIS FILE DOES:
--   1. Guard-create the two enums (idempotent). They also reach prod via the
--      normal Publish (drizzle) diff; the guard is for an env where 0089 lands
--      before Publish.
--   2. CREATE TABLE IF NOT EXISTS settlement_links + indexes + the CHECK.
--   3. DATA backfill: one deterministic `sl_<payout_id>` row per non-`unmatched`
--      payout, mapped from today's `qb_reconciliation_status`:
--        unmatched          -> no row
--        proposed           -> (proposed, system),  deposit = proposed_qb
--        conflict_approved  -> (proposed, system),  deposit = COALESCE(qb_conflict, proposed),
--                              note='legacy conflict_approved'
--        confirmed_reconciled/_keep/_replace/_excluded
--                           -> (confirmed, human|system_confirmed),
--                              deposit = COALESCE(matched, qb_conflict, proposed),
--                              confirmed_by/at from qb_reconciliation_confirmed_*,
--                              note='legacy <status>' for keep/replace/excluded
--      This converges EXACTLY with the runtime dual-write (same deterministic id),
--      so a payout re-reconciled in the app after this backfill is a no-op.
--
--   RATIFIED MAPPING (see docs/reconciliation-design.md §4.3): legacy
--   `confirmed_excluded` -> a CONFIRMED link. It is a *settlement* status
--   ("payout<->deposit tie WAS confirmed; the coarse QB lump was suppressed via
--   processor_payout so per-charge Stripe gifts aren't double-counted"), NOT a
--   non-gift QB exclusion — those (membership / reimbursement / service revenue)
--   live on `staged_payments.exclusion_reason` (Plane 2) and are untouched here.
--
--   Any payout whose resolved deposit pointer is NULL or dangling is SKIPPED (no
--   row) — it honestly derives as `orphan` rather than forging a settlement tie.
--
-- ROLLOUT (additive dual-write phase): the reconcile/confirm/revert + mint/link
--   choke points already write settlement_links ALONGSIDE
--   `qb_reconciliation_status` + the pointer columns. Reads are NOT flipped to it
--   yet (that read cutover is a separate task, gated on PROD parity via
--   `pnpm --filter @workspace/api-server run parity:settlement-links`).
--
-- PUBLISH ORDERING (invariant #7): the enums + table + indexes also reach prod via
--   the normal Publish diff. This file is the self-contained, idempotent equivalent
--   (mirrors 0088) so it can run before OR after Publish with the same result. The
--   step 3 backfill is DATA and only this file writes it.
--
-- IDEMPOTENCY / SAFETY:
--   * Re-running is a no-op: enum guards swallow duplicate_object, the table/indexes
--     are IF NOT EXISTS, and the backfill INSERT is ON CONFLICT (id) DO NOTHING on
--     the deterministic `sl_<payout_id>` id + the UNIQUE(payout_id).
--   * NOTHING is dropped. Purely additive infrastructure + a mirror backfill.
--     qb_reconciliation_status + the pointer columns are left untouched (they remain
--     the dual-write source of truth until a later drop phase).
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0089_settlement_links.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Enums (idempotent) ─────────────────────────────────────────────────
DO $$
BEGIN
  CREATE TYPE settlement_link_lifecycle AS ENUM ('proposed', 'confirmed', 'exempt');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE settlement_link_provenance AS ENUM ('system', 'system_confirmed', 'human');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. Table + indexes (idempotent) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlement_links (
  -- Deterministic `sl_<payout_id>` so the runtime dual-write and this backfill
  -- converge (one link per payout).
  id                        text PRIMARY KEY,
  payout_id                 text NOT NULL REFERENCES stripe_payouts (id) ON DELETE CASCADE,
  -- The QB deposit lump line the payout landed as. NULL only for an `exempt` link.
  deposit_staged_payment_id text REFERENCES staged_payments (id) ON DELETE SET NULL,
  lifecycle                 settlement_link_lifecycle NOT NULL,
  provenance                settlement_link_provenance NOT NULL DEFAULT 'system',
  confirmed_by_user_id      text REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at              timestamptz,
  note                      text,
  created_at                timestamp NOT NULL DEFAULT now(),
  updated_at                timestamp NOT NULL DEFAULT now(),
  -- A non-exempt link must tie to a QB deposit; only `exempt` may omit it.
  CONSTRAINT settlement_links_deposit_required_chk
    CHECK (lifecycle = 'exempt' OR deposit_staged_payment_id IS NOT NULL)
);

-- Exclusivity: at most one settlement link per payout.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_links_payout_id_uq
  ON settlement_links (payout_id);
CREATE INDEX IF NOT EXISTS settlement_links_deposit_staged_payment_id_idx
  ON settlement_links (deposit_staged_payment_id);
CREATE INDEX IF NOT EXISTS settlement_links_lifecycle_idx
  ON settlement_links (lifecycle);

-- ─── 3. Backfill from qb_reconciliation_status ─────────────────────────────
INSERT INTO settlement_links (
  id, payout_id, deposit_staged_payment_id, lifecycle, provenance,
  confirmed_by_user_id, confirmed_at, note, created_at, updated_at
)
SELECT
  'sl_' || p.id,
  p.id,
  d.deposit_id,
  d.lifecycle::settlement_link_lifecycle,
  d.provenance::settlement_link_provenance,
  d.confirmed_by,
  d.confirmed_at,
  d.note,
  now(),
  now()
FROM stripe_payouts p
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN p.qb_reconciliation_status IN ('proposed', 'conflict_approved') THEN 'proposed'
      ELSE 'confirmed'
    END AS lifecycle,
    CASE
      WHEN p.qb_reconciliation_status IN ('proposed', 'conflict_approved') THEN 'system'
      WHEN p.qb_reconciliation_confirmed_by_user_id IS NOT NULL THEN 'human'
      ELSE 'system_confirmed'
    END AS provenance,
    CASE
      WHEN p.qb_reconciliation_status = 'proposed'
        THEN p.proposed_qb_staged_payment_id
      WHEN p.qb_reconciliation_status = 'conflict_approved'
        THEN COALESCE(p.qb_conflict_staged_payment_id, p.proposed_qb_staged_payment_id)
      ELSE
        COALESCE(p.matched_qb_staged_payment_id, p.qb_conflict_staged_payment_id, p.proposed_qb_staged_payment_id)
    END AS deposit_id,
    CASE
      WHEN p.qb_reconciliation_status LIKE 'confirmed_%'
        THEN p.qb_reconciliation_confirmed_by_user_id
      ELSE NULL
    END AS confirmed_by,
    CASE
      WHEN p.qb_reconciliation_status LIKE 'confirmed_%'
        THEN COALESCE(p.qb_reconciliation_confirmed_at, p.updated_at)
      ELSE NULL
    END AS confirmed_at,
    CASE p.qb_reconciliation_status
      WHEN 'conflict_approved'   THEN 'legacy conflict_approved'
      WHEN 'confirmed_keep'      THEN 'legacy confirmed_keep'
      WHEN 'confirmed_replace'   THEN 'legacy confirmed_replace'
      WHEN 'confirmed_excluded'  THEN 'legacy confirmed_excluded'
      ELSE NULL
    END AS note
) d
WHERE p.qb_reconciliation_status <> 'unmatched'
  AND d.deposit_id IS NOT NULL
  -- Skip a dangling pointer (would otherwise violate the FK and abort the run);
  -- such a payout honestly derives as `orphan`.
  AND EXISTS (SELECT 1 FROM staged_payments sp WHERE sp.id = d.deposit_id)
ON CONFLICT (id) DO NOTHING;

-- ─── 4. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_total     int;
  n_proposed  int;
  n_confirmed int;
  n_exempt    int;
BEGIN
  SELECT count(*) INTO n_total     FROM settlement_links;
  SELECT count(*) INTO n_proposed  FROM settlement_links WHERE lifecycle = 'proposed';
  SELECT count(*) INTO n_confirmed FROM settlement_links WHERE lifecycle = 'confirmed';
  SELECT count(*) INTO n_exempt    FROM settlement_links WHERE lifecycle = 'exempt';
  RAISE NOTICE '0089: settlement_links=% (proposed=%, confirmed=%, exempt=%) backfilled from qb_reconciliation_status', n_total, n_proposed, n_confirmed, n_exempt;
END $$;
