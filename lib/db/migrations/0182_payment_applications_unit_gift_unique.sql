-- 0182: additive unit-level corroborating (payment_unit_id, gift_id) uniqueness.
--
-- Phase D step 2, ADDITIVE half. Adds the corroborating-dedupe key on the
-- canonical unit that subsumes the two retiring per-anchor corroborating
-- uniques (`(payment_id, gift_id)` / `(stripe_charge_id, gift_id)` WHERE
-- link_role='corroborating') and backs the corrections-flow corroborating
-- upsert. Partial on link_role so it is DISJOINT from the counted-per-unit
-- invariant (0180) — a counted row and a corroborating row for the same
-- (unit, gift) may coexist (a settlement-supersede demote later collapses them),
-- exactly as the retired disjoint per-anchor uniques allowed.
--
-- The retired per-anchor COUNTED (anchor, gift) uniques are NOT replaced by a
-- unit-level counterpart: `payment_applications_payment_unit_id_counted_uq`
-- (0180, one counted row per unit, full stop) already subsumes them.
--
-- Safe to apply while the current release still dual-writes the legacy anchor
-- columns: no existing corroborating row violates it (verified 0 duplicate
-- (payment_unit_id, gift_id) pairs on the prod clone).
--
-- Apply this BEFORE publishing the Phase D step 2 code — the corrections flow's
-- new ON CONFLICT (payment_unit_id, gift_id) WHERE corroborating arbiter needs
-- this index to exist. The destructive half (0183) drops the legacy
-- columns/indexes/constraints and runs AFTER publish.
--
-- Idempotent: IF NOT EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS
  payment_applications_payment_unit_id_gift_id_corroborating_uq
  ON payment_applications (payment_unit_id, gift_id)
  WHERE link_role = 'corroborating';
