-- Migration 0088: Durable "these evidence UNITS are really ONE gift" grouping.
--
-- WHY:
--   Plane 2 cleanup op (docs/reconciliation-design.md §4.6b, Decision 7). Today a
--   grouped set of staged payments is tracked ONLY by
--   `staged_payments.source_group_id` — a column that (a) lives on a single
--   evidence table (staged_payments), so it can never group a Stripe charge or a
--   Donorbox donation, and (b) is a sync-owned column the QuickBooks re-pull can
--   clobber. `unit_groups` generalizes it into a first-class, sync-safe, POLY-
--   MORPHIC association so a grouped set persists and displays as one logical
--   unit BEFORE and AFTER it is matched to a gift, while the underlying evidence
--   rows stay pristine for the sync to re-own (INV-G).
--
--   Membership is `(evidence_source, source_id)` — the SAME shape the
--   `payment_applications` ledger uses — so grouping never needs a column on
--   three different evidence tables. `source_id` is plain text with NO FK
--   (polymorphic across three anchors; mirrors the staging-table convention).
--   Membership is EXCLUSIVE: a unit belongs to at most one group, enforced by a
--   UNIQUE(evidence_source, source_id).
--
-- WHAT THIS FILE DOES:
--   1. Guard the `payment_application_evidence_source` enum (idempotent). It
--      already exists in prod (the ledger shipped first) — the guard is only for
--      an environment where 0088 somehow lands before that enum.
--   2. CREATE TABLE IF NOT EXISTS unit_groups + unit_group_members + indexes.
--   3. DATA backfill: fold every existing >= 2-member source_group_id group into
--      a deterministic `ug_<source_group_id>` group with `ugm_<staged_payment_id>`
--      quickbooks members. This converges EXACTLY with the runtime dual-write
--      (same deterministic ids), so a group re-grouped in the app after this
--      backfill is a no-op, not a duplicate.
--
-- ROLLOUT (additive dual-write phase — WS2): the group/ungroup endpoints already
--   dual-write these tables ALONGSIDE source_group_id. Reads are NOT flipped to
--   them yet (that is the WS1 mechanism collapse, strictly after PROD parity via
--   `pnpm --filter @workspace/api-server run parity:unit-groups`).
--
-- PUBLISH ORDERING (invariant #7): the enum + tables + indexes also reach prod
--   through the normal Publish (drizzle) diff. This file is the self-contained,
--   idempotent equivalent (mirrors 0084) so it can run before OR after Publish
--   with the same result. The step 3 backfill is DATA and only this file writes
--   it — it must run AFTER the tables exist (they do, by step 2 or by Publish).
--
-- IDEMPOTENCY / SAFETY:
--   * Re-running is a no-op: the enum guard swallows duplicate_object, the
--     table/indexes are IF NOT EXISTS, and the backfill INSERTs are
--     ON CONFLICT DO NOTHING on deterministic ids + the exclusivity unique index.
--   * NOTHING is dropped. Purely additive infrastructure + a mirror backfill.
--     source_group_id is left untouched (dual-write source of truth until Phase 7).
--
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0088_unit_groups.sql
--
-- Run with `-1` (psql wraps the whole file in ONE transaction). Do NOT add an
-- internal BEGIN/COMMIT — `-1` already provides the single-transaction guarantee.

-- ─── 1. Evidence-source enum (idempotent; already present in prod) ──────────
DO $$
BEGIN
  CREATE TYPE payment_application_evidence_source AS ENUM ('quickbooks', 'stripe', 'donorbox');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ─── 2. Tables + indexes (idempotent) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS unit_groups (
  -- Deterministic `ug_<source_group_id>` when created from a staged-payment
  -- source group, so the runtime dual-write and this backfill converge.
  id                  text PRIMARY KEY,
  label               text,
  note                text,
  created_by_user_id  text REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS unit_group_members (
  -- Deterministic `ugm_<source_id>` (a unit is in at most one group) so re-runs
  -- are no-ops.
  id              text PRIMARY KEY,
  group_id        text NOT NULL REFERENCES unit_groups (id) ON DELETE CASCADE,
  evidence_source payment_application_evidence_source NOT NULL,
  source_id       text NOT NULL,
  created_at      timestamp NOT NULL DEFAULT now()
);

-- Exclusivity: a unit belongs to at most one group.
CREATE UNIQUE INDEX IF NOT EXISTS unit_group_members_source_uq
  ON unit_group_members (evidence_source, source_id);
CREATE INDEX IF NOT EXISTS unit_group_members_group_id_idx
  ON unit_group_members (group_id);

-- ─── 3. Backfill from existing source_group_id groups (>= 2 members) ────────
-- Group rows: one deterministic ug_<sgid> per source group that has >= 2 members.
INSERT INTO unit_groups (id, created_at, updated_at)
SELECT 'ug_' || sp.source_group_id, now(), now()
FROM staged_payments sp
WHERE sp.source_group_id IS NOT NULL
GROUP BY sp.source_group_id
HAVING COUNT(*) >= 2
ON CONFLICT (id) DO NOTHING;

-- Member rows: one deterministic ugm_<staged_payment_id> per member of those
-- groups, as a `quickbooks` unit. ON CONFLICT (id) covers a re-run; the
-- exclusivity unique index additionally protects against a unit that was already
-- claimed by a different group id (would raise — but a unit only ever has one
-- source_group_id, so ids and membership are 1:1 here).
INSERT INTO unit_group_members (id, group_id, evidence_source, source_id, created_at)
SELECT 'ugm_' || sp.id, 'ug_' || sp.source_group_id, 'quickbooks', sp.id, now()
FROM staged_payments sp
WHERE sp.source_group_id IS NOT NULL
  AND sp.source_group_id IN (
    SELECT source_group_id
    FROM staged_payments
    WHERE source_group_id IS NOT NULL
    GROUP BY source_group_id
    HAVING COUNT(*) >= 2
  )
ON CONFLICT (id) DO NOTHING;

-- ─── 4. Operator report (non-aborting) ─────────────────────────────────────
DO $$
DECLARE
  n_groups  int;
  n_members int;
BEGIN
  SELECT count(*) INTO n_groups FROM unit_groups;
  SELECT count(*) INTO n_members FROM unit_group_members;
  RAISE NOTICE '0088: unit_groups=% ; unit_group_members=% (backfilled from source_group_id >= 2-member groups)', n_groups, n_members;
END $$;
