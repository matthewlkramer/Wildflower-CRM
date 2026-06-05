-- 0022_staged_payment_gift_was_linked.sql
--
-- Adds staged_payments.gift_was_linked so the two "approved" resolutions can be
-- told apart. created_gift_id is overloaded: it is set both when "Approve →
-- create gift" mints a NEW gifts_and_payments row and when "Link to existing
-- gift" ties the staged row to a PRE-EXISTING gift. The new "Unlink" action
-- must only ever sever a *linked* row (severing a minted approval would orphan
-- the gift it created), so we record which resolution happened.
--
-- gift_was_linked = true  → row was tied to a pre-existing gift (link endpoint)
-- gift_was_linked = false → minted via approve, OR not yet approved
--
-- NOTE ON HISTORY: existing approved rows all default to false, including any
-- that were genuinely linked before this column existed. That is intentional —
-- there is no reliable way to reconstruct linked-vs-minted after the fact, so
-- the Unlink affordance applies only to links created from this point forward.
--
-- Idempotent and additive (safe to re-run).

ALTER TABLE staged_payments
  ADD COLUMN IF NOT EXISTS gift_was_linked boolean NOT NULL DEFAULT false;
