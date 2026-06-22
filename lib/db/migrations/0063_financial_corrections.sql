-- 0063_financial_corrections
--
-- Backs the financial-corrections review queue (Task #338, INV-5/6 & §4.2/§4.8).
-- Adds two additive tables:
--
--   * gift_evidence_links — the many-to-many CORROBORATING layer between a CRM
--     gift and a piece of funding/accounting evidence (a QuickBooks staged row
--     or a Stripe staged charge). One gift may point at several evidence rows
--     and one evidence row may corroborate several gifts. These links are
--     corroborating ONLY and never contribute to any counted total, so book-once
--     is preserved structurally (the COUNTED source stays the existing single
--     pointer on gifts_and_payments / staged_payments / staged_payment_splits).
--     evidence_id is polymorphic (staged_payments.id OR stripe_staged_charges.id)
--     disambiguated by evidence_kind, so it carries NO foreign key — like
--     duplicate_dismissals. The gift FK is CASCADE: a corroborating link is a
--     re-derivable annotation, not part of the money trail.
--
--   * financial_correction_dismissals — proposals an admin has explicitly
--     dismissed, keyed by canonical proposal_key, so the detector never
--     re-surfaces them. Mirrors duplicate_dismissals (0054).
--
-- See 0063_financial_corrections_RUNBOOK.md.
--
-- Idempotent and additive: safe to re-run. No existing data is read or modified;
-- this only adds new tables and indexes.

CREATE TABLE IF NOT EXISTS gift_evidence_links (
  id text PRIMARY KEY,
  gift_id text NOT NULL
    REFERENCES gifts_and_payments (id) ON DELETE CASCADE,
  evidence_kind text NOT NULL,
  evidence_id text NOT NULL,
  sub_amount numeric(14, 2),
  note text,
  created_by_user_id text REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT gift_evidence_links_evidence_kind
    CHECK (evidence_kind IN ('qb_staged', 'stripe_charge'))
);

CREATE UNIQUE INDEX IF NOT EXISTS gift_evidence_links_gift_evidence_uq
  ON gift_evidence_links (gift_id, evidence_kind, evidence_id);
CREATE INDEX IF NOT EXISTS gift_evidence_links_evidence_idx
  ON gift_evidence_links (evidence_kind, evidence_id);
CREATE INDEX IF NOT EXISTS gift_evidence_links_gift_id_idx
  ON gift_evidence_links (gift_id);

CREATE TABLE IF NOT EXISTS financial_correction_dismissals (
  id text PRIMARY KEY,
  kind text NOT NULL,
  proposal_key text NOT NULL,
  dismissed_by_user_id text,
  dismissed_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_correction_dismissals_key_unique
  ON financial_correction_dismissals (kind, proposal_key);
