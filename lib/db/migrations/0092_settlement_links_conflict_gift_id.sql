-- Migration 0092: settlement_links.conflict_gift_id (Phase-4 write-flip, step 1).
--
-- WHY:
--   docs/reconciliation-design.md §4.3 / §4.5 / §7 step 4. The Phase-4 WRITE-flip
--   makes `settlement_links` the authoritative home for the Stripe payout <-> QB
--   deposit settlement so the 7-value `stripe_payouts.qb_reconciliation_status`
--   enum + its pointer columns can retire. Reads are already flipped (live).
--
--   BUT the 3-value settlement_link_lifecycle (proposed | confirmed | exempt)
--   cannot represent the legacy `conflict_approved` state — a proposal that landed
--   on a QB gift ALREADY booked, awaiting the human's keep/replace decision — nor
--   the `qb_conflict_gift_id` that state carries. That gift pointer is load-bearing:
--   revert-of-keep uses its PRESENCE as the discriminator and the double-book
--   guards read it. deriveSettlementLinkFields therefore collapsed both `proposed`
--   AND `conflict_approved` into the SAME (proposed, system) link, losing the
--   conflict — the write inversion cannot proceed until the link can round-trip it.
--
--   This file adds a nullable `settlement_links.conflict_gift_id`
--   (FK -> gifts_and_payments, ON DELETE SET NULL). A conflict then becomes
--   `lifecycle = 'proposed' AND conflict_gift_id IS NOT NULL` — deliberately NOT a
--   4th lifecycle value (that would contradict the ratified §4.5 target and fork
--   every shipped lifecycle read). It mirrors `stripe_payouts.qb_conflict_gift_id`
--   and is RETAINED on the resulting `confirmed` link too.
--
-- WHAT THIS FILE DOES (all idempotent):
--   1. ADD COLUMN IF NOT EXISTS settlement_links.conflict_gift_id + its FK + index.
--      These also reach prod via the normal Publish (drizzle) diff; the guards are
--      for an env where this file lands before Publish (mirrors 0089's pattern).
--   2. DATA backfill: mirror `stripe_payouts.qb_conflict_gift_id` onto each payout's
--      existing settlement link. Matches deriveSettlementLinkFields +
--      settlementLink.ts dual-write EXACTLY (conflict_gift_id = the payout's
--      qb_conflict_gift_id, for BOTH proposed-family AND confirmed-family links),
--      so a payout re-reconciled in the app after this backfill is a no-op.
--
-- ROLLOUT (additive; enum still AUTHORITATIVE this step): purely additive. The
--   authoritative WRITE inversion onto settlement_links is a SEPARATE, later Publish,
--   gated on this file's PROD parity pass
--   (pnpm --filter @workspace/api-server run parity:settlement-links). An additive
--   step and an authority flip must NEVER ship in the same Publish
--   (docs/reconciliation-design.md §7) — there must be a prod-parity checkpoint
--   between them (dev parity ≠ prod parity).
--
-- PUBLISH ORDERING (invariant #7): the column + FK + index also reach prod via the
--   normal Publish diff. This file is the self-contained, idempotent equivalent so
--   it can run before OR after Publish with the same result. The step-2 backfill is
--   DATA and only this file writes it.
--
-- IDEMPOTENCY / SAFETY:
--   * Re-running is a no-op: ADD COLUMN / index are IF NOT EXISTS, the FK is
--     guard-created (duplicate_object swallowed), and the UPDATE is deterministic
--     (sets the same value every run, gated by IS DISTINCT FROM).
--   * NOTHING is dropped. qb_conflict_gift_id + the enum are left untouched (they
--     remain the dual-write source of truth until the later authority flip).
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0092_settlement_links_conflict_gift_id.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Column + FK + index (idempotent) ───────────────────────────────────
ALTER TABLE settlement_links
  ADD COLUMN IF NOT EXISTS conflict_gift_id text;

DO $$
BEGIN
  ALTER TABLE settlement_links
    ADD CONSTRAINT settlement_links_conflict_gift_id_gifts_and_payments_id_fk
    FOREIGN KEY (conflict_gift_id) REFERENCES gifts_and_payments (id)
    ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS settlement_links_conflict_gift_id_idx
  ON settlement_links (conflict_gift_id);

-- ─── 2. Backfill from stripe_payouts.qb_conflict_gift_id ───────────────────
-- Mirror the payout's conflict gift onto its link (proposed-family AND
-- confirmed-family), EXACTLY as deriveSettlementLinkFields now emits it. Only rows
-- whose payout carries a conflict gift change; the rest stay NULL. The EXISTS guard
-- defensively skips a (structurally impossible — qb_conflict_gift_id is itself an
-- FK) dangling pointer so it can't abort the run.
UPDATE settlement_links sl
SET conflict_gift_id = p.qb_conflict_gift_id,
    updated_at = now()
FROM stripe_payouts p
WHERE sl.payout_id = p.id
  AND p.qb_conflict_gift_id IS NOT NULL
  AND sl.conflict_gift_id IS DISTINCT FROM p.qb_conflict_gift_id
  AND EXISTS (
    SELECT 1 FROM gifts_and_payments g WHERE g.id = p.qb_conflict_gift_id
  );

-- ─── 3. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_conflict int;
BEGIN
  SELECT count(*) INTO n_conflict FROM settlement_links WHERE conflict_gift_id IS NOT NULL;
  RAISE NOTICE '0092: settlement_links with conflict_gift_id set = %', n_conflict;
END $$;
