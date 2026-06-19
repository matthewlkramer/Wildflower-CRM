-- 0050_revenue_coding_capture.sql
--
-- Revenue-accounting / QuickBooks coding capture (CFO "Revenue Extractor").
--
-- Idempotent. Seeds the closed Revenue Account list + the per-entity coding
-- rules (fiscal-sponsee "SPO" defaults), and backfills `restriction_type` on the
-- existing gift_allocations / pledge_allocations from their legacy restriction
-- booleans. The new columns + enums themselves are created by the normal Publish
-- schema diff (drizzle push); this file only seeds + backfills DATA, so it is
-- safe to run against any environment that already has the columns.
--
-- Backfill rule (conservative — never invents purpose/time detail):
--   * a restriction boolean set  → 'purpose'      (a formal restriction exists)
--   * no restriction boolean set → 'unclear'      (NEVER silently 'unrestricted')
-- Rows already carrying a restriction_type are left untouched.
--
-- Apply with:
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0050_revenue_coding_capture.sql
--
-- The `-1` flag already wraps the whole file in a single transaction, so this
-- file declares no BEGIN/COMMIT of its own (doing both prints a harmless
-- "there is already a transaction in progress" warning). Apply ONLY after the
-- schema diff has been published — these tables/columns/enums are created by the
-- Publish flow, not here.

-- ── 1. Seed the closed Revenue Account list ────────────────────────────────
INSERT INTO revenue_accounts (code, name, kind, payer_type, sort_order, active)
VALUES
  ('4000.1', 'Unrestricted Donations - Individual',   'unrestricted', 'individual',   10,  true),
  ('4000.2', 'Unrestricted Donations - Foundation',   'unrestricted', 'foundation',   20,  true),
  ('4000.3', 'Unrestricted Donations - Corporation',  'unrestricted', 'corporation',  30,  true),
  ('4000.4', 'Unrestricted Donations - Governmental', 'unrestricted', 'governmental', 40,  true),
  ('4010',   'Interest Earned',                        'special',      NULL,           50,  true),
  ('4020',   'Services - Earned Income',               'special',      NULL,           60,  true),
  ('4099',   'Uncategorized Revenue',                  'special',      NULL,           70,  true),
  ('4100.1', 'Restricted Donations - Individual',      'restricted',   'individual',   80,  true),
  ('4100.2', 'Restricted Donations - Foundation',      'restricted',   'foundation',   90,  true),
  ('4100.3', 'Restricted Donations - Corporation',     'restricted',   'corporation',  100, true),
  ('4100.4', 'Restricted Donations - Governmental',    'restricted',   'governmental', 110, true),
  ('4102',   'Guaranty Revenue',                       'special',      NULL,           120, true),
  ('4300',   'Intercompany Donation Allocation',       'special',      NULL,           130, true),
  ('4500',   'Loan Fund Servicing',                    'special',      NULL,           140, true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      payer_type = EXCLUDED.payer_type,
      sort_order = EXCLUDED.sort_order,
      updated_at = now();

-- ── 2. Seed per-entity coding rules (only for entities that exist) ──────────
-- Fiscal sponsees are always purpose-restricted; loan entities route to Loans.
INSERT INTO entity_coding_rules (entity_id, force_restricted, location, revenue_class, enabled, notes)
SELECT v.entity_id, v.force_restricted, v.location, v.revenue_class, v.enabled, v.notes
FROM (VALUES
  ('black_wildflowers_fund', true,  'Spo- Black Wildflowers Fund', 'General Operations'::text, true,
     'Fiscal sponsee — always purpose-restricted to BWF; class General Operations.'),
  ('tierra_indigena',        true,  'Spo- Tierra Indígena',        NULL::text,                 true,
     'Fiscal sponsee — always purpose-restricted to Tierra Indígena; no class.'),
  ('sunlight_debt',          false, 'Loans',                       NULL::text,                 true,
     'Loan-fund entity — routes to Loans location.'),
  ('sunlight_grants',        false, 'Loans',                       NULL::text,                 true,
     'Loan-fund entity — routes to Loans location.')
) AS v(entity_id, force_restricted, location, revenue_class, enabled, notes)
WHERE EXISTS (SELECT 1 FROM entities en WHERE en.id = v.entity_id)
ON CONFLICT (entity_id) DO NOTHING;

-- ── 3. Backfill restriction_type on gift_allocations ───────────────────────
UPDATE gift_allocations
SET restriction_type =
  CASE
    WHEN formal_fund_use_restriction OR formal_regional_restriction THEN 'purpose'::restriction_type
    ELSE 'unclear'::restriction_type
  END
WHERE restriction_type IS NULL;

-- ── 4. Backfill restriction_type on pledge_allocations ─────────────────────
UPDATE pledge_allocations
SET restriction_type =
  CASE
    WHEN formally_restricted THEN 'purpose'::restriction_type
    ELSE 'unclear'::restriction_type
  END
WHERE restriction_type IS NULL;
