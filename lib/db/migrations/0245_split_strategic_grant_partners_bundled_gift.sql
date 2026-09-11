-- 0245: Split Strategic Grant Partners' bundled FY19 receipt into a
-- $300,000 pledge payment and a separate $25,000 direct gift.
--
-- OWNER-CONFIRMED TARGET:
--   * pledge rectelDbOgMh2Ca3y remains $800,000;
--   * its three active payments are $400,000, $100,000, and $300,000;
--   * the extra $25,000 is a stand-alone Strategic Grant Partners gift;
--   * the 2018-09-06 Wells Fargo deposit remains one $326,500 bank event;
--   * the existing $300,000 QuickBooks record is not modified;
--   * CRM deposit composition becomes $300,000 pledge payment + $25,000
--     direct gift + the existing excluded $1,500 component.
--
-- SAFE / IDEMPOTENT:
--   * first-run preflight locks onto the exact reviewed opportunity, gifts,
--     allocation split, payment unit, QBO evidence, component, and bank deposit;
--   * it aborts if any reviewed amount, link, date, or target count drifted;
--   * it never updates bank_deposits, bank_transactions, staged_payments,
--     qbo_accounting_checks, or source_links;
--   * deterministic ids plus one audit marker make successful re-runs no-ops;
--   * the postflight proves both the pledge rollup and deposit composition.
--
-- Production is human-applied from the repository root:
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--     -f lib/db/migrations/0245_split_strategic_grant_partners_bundled_gift.sql
--
-- Do not add BEGIN/COMMIT: psql -1 owns the transaction.

DO $$
DECLARE
  v_audit_count integer;
  v_pledge_count integer;
  v_pledge_gift_count integer;
  v_pledge_gift_total numeric;
  v_original_gift_count integer;
  v_original_allocation_count integer;
  v_original_allocation_total numeric;
  v_300_allocation_count integer;
  v_25_allocation_count integer;
  v_payment_unit_count integer;
  v_component_count integer;
  v_deposit_component_count integer;
  v_deposit_component_total numeric;
  v_excluded_1500_count integer;
  v_staged_payment_count integer;
  v_deposit_count integer;
  v_reserved_id_count bigint;
BEGIN
  SELECT count(*)::integer
    INTO v_audit_count
    FROM audit_log
   WHERE id = 'audit_0245_sgp_bundled_gift_split';

  IF v_audit_count > 1 THEN
    RAISE EXCEPTION
      '0245 preflight: expected at most one migration audit row, found %',
      v_audit_count;
  END IF;

  -- A prior successful application is verified by the postflight below. The
  -- first-run checks intentionally describe only the reviewed pre-state.
  IF v_audit_count = 0 THEN
    SELECT count(*)::integer
      INTO v_pledge_count
      FROM opportunities_and_pledges
     WHERE id = 'rectelDbOgMh2Ca3y'
       AND archived_at IS NULL
       AND awarded_amount = 800000::numeric
       AND paid = 800000::numeric
       AND pledge_committed_at IS NOT NULL
       AND loan_or_grant = 'grant';

    SELECT count(*)::integer, COALESCE(sum(amount), 0)
      INTO v_pledge_gift_count, v_pledge_gift_total
      FROM gifts_and_payments
     WHERE opportunity_id = 'rectelDbOgMh2Ca3y'
       AND archived_at IS NULL;

    SELECT count(*)::integer
      INTO v_original_gift_count
      FROM gifts_and_payments
     WHERE id = 'recaKMBM7D9Bxv662'
       AND opportunity_id = 'rectelDbOgMh2Ca3y'
       AND organization_id IS NOT NULL
       AND individual_giver_person_id IS NULL
       AND household_id IS NULL
       AND amount = 325000::numeric
       AND date_received = DATE '2017-06-07'
       AND archived_at IS NULL;

    SELECT
      count(*)::integer,
      COALESCE(sum(sub_amount), 0),
      count(*) FILTER (
        WHERE sub_amount = 300000::numeric AND grant_year = 'fy2019'
      )::integer,
      count(*) FILTER (
        WHERE sub_amount = 25000::numeric AND grant_year = 'fy2019'
      )::integer
    INTO
      v_original_allocation_count,
      v_original_allocation_total,
      v_300_allocation_count,
      v_25_allocation_count
    FROM gift_allocations
    WHERE gift_id = 'recaKMBM7D9Bxv662';

    SELECT count(*)::integer
      INTO v_payment_unit_count
      FROM payment_units
     WHERE id = 'pu_eYUufuwn1mea0hs80eKzK'
       AND gift_id = 'recaKMBM7D9Bxv662'
       AND stripe_charge_id IS NULL
       AND donorbox_donation_id IS NULL
       AND source_staged_payment_id = 'eYUufuwn1mea0hs80eKzK'
       AND gross_amount = 325000::numeric
       AND (net_amount IS NULL OR net_amount = 325000::numeric)
       AND received_date = DATE '2018-09-06'
       AND lifecycle = 'received';

    SELECT count(*)::integer
      INTO v_component_count
      FROM bank_deposit_components
     WHERE bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2'
       AND payment_unit_id = 'pu_eYUufuwn1mea0hs80eKzK'
       AND amount = 325000::numeric
       AND exclusion_reason IS NULL;

    SELECT
      count(*)::integer,
      COALESCE(sum(amount), 0),
      count(*) FILTER (
        WHERE payment_unit_id <> 'pu_eYUufuwn1mea0hs80eKzK'
          AND amount = 1500::numeric
          AND exclusion_reason IS NOT NULL
      )::integer
    INTO
      v_deposit_component_count,
      v_deposit_component_total,
      v_excluded_1500_count
    FROM bank_deposit_components
    WHERE bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2';

    SELECT count(*)::integer
      INTO v_staged_payment_count
      FROM staged_payments
     WHERE id = 'eYUufuwn1mea0hs80eKzK'
       AND amount = 300000::numeric
       AND date_received = DATE '2018-09-06';

    SELECT count(*)::integer
      INTO v_deposit_count
      FROM bank_deposits
     WHERE id = 'bdep_0600314fc0e164a1f15604c2'
       AND amount = 326500::numeric
       AND deposit_date = DATE '2018-09-06';

    SELECT
      (SELECT count(*) FROM gifts_and_payments
        WHERE id = 'gift_0245_sgp_direct_25')
      + (SELECT count(*) FROM payment_units
          WHERE id = 'pu_manual_0245_sgp_direct_25')
      + (SELECT count(*) FROM bank_deposit_components
          WHERE id = 'bdc_manual_0245_sgp_direct_25')
      INTO v_reserved_id_count;

    IF v_pledge_count <> 1 THEN
      RAISE EXCEPTION
        '0245 preflight: the reviewed $800,000 SGP pledge is missing or changed';
    END IF;

    IF v_pledge_gift_count <> 3 OR v_pledge_gift_total <> 825000::numeric THEN
      RAISE EXCEPTION
        '0245 preflight: expected 3 active pledge gifts totaling $825,000; found % totaling %',
        v_pledge_gift_count, v_pledge_gift_total;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM gifts_and_payments
       WHERE id = 'recYYkpHXjHh2n7g6'
         AND opportunity_id = 'rectelDbOgMh2Ca3y'
         AND amount = 400000::numeric
         AND archived_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM gifts_and_payments
       WHERE id = 'rec6elo1J3tNAoAjs'
         AND opportunity_id = 'rectelDbOgMh2Ca3y'
         AND amount = 100000::numeric
         AND archived_at IS NULL
    ) THEN
      RAISE EXCEPTION
        '0245 preflight: the reviewed $400,000 and $100,000 pledge payments changed';
    END IF;

    IF v_original_gift_count <> 1 THEN
      RAISE EXCEPTION
        '0245 preflight: the reviewed $325,000 SGP gift is missing or changed';
    END IF;

    IF v_original_allocation_count <> 2
       OR v_original_allocation_total <> 325000::numeric
       OR v_300_allocation_count <> 1
       OR v_25_allocation_count <> 1 THEN
      RAISE EXCEPTION
        '0245 preflight: expected exactly the reviewed FY2019 $300,000 + $25,000 allocation split';
    END IF;

    IF v_payment_unit_count <> 1 OR v_component_count <> 1 THEN
      RAISE EXCEPTION
        '0245 preflight: the reviewed $325,000 payment unit/component link changed';
    END IF;

    IF v_deposit_count <> 1
       OR v_deposit_component_count <> 2
       OR v_deposit_component_total <> 326500::numeric
       OR v_excluded_1500_count <> 1 THEN
      RAISE EXCEPTION
        '0245 preflight: the reviewed $326,500 deposit composition changed';
    END IF;

    IF v_staged_payment_count <> 1 THEN
      RAISE EXCEPTION
        '0245 preflight: the source $300,000 QuickBooks record changed';
    END IF;

    IF v_reserved_id_count <> 0 THEN
      RAISE EXCEPTION
        '0245 preflight: one or more deterministic target ids are already in use';
    END IF;
  END IF;
END $$;

-- Create the direct-gift header by copying only the donor/stewardship fields
-- that should remain common. The existing acknowledgement and grant documents
-- stay with the pledge payment; they are not duplicated onto the new gift.
INSERT INTO gifts_and_payments (
  id,
  name,
  details,
  fundraising_campaign,
  campaign_slug,
  date_received,
  payment_method,
  amount,
  organization_id,
  individual_giver_person_id,
  household_id,
  loan_or_grant,
  opportunity_id,
  primary_contact_person_id,
  payment_intermediary_id,
  owner_user_id,
  awaiting_settlement,
  tags,
  created_at,
  updated_at
)
SELECT
  'gift_0245_sgp_direct_25',
  'Strategic Grant Partners FY19 direct gift',
  'Separated from the bundled $325,000 receipt: $300,000 paid the FY18-19 pledge and $25,000 was an additional direct gift (migration 0245).',
  g.fundraising_campaign,
  g.campaign_slug,
  g.date_received,
  g.payment_method,
  25000::numeric,
  g.organization_id,
  g.individual_giver_person_id,
  g.household_id,
  g.loan_or_grant,
  NULL,
  g.primary_contact_person_id,
  g.payment_intermediary_id,
  g.owner_user_id,
  false,
  g.tags,
  now(),
  now()
FROM gifts_and_payments g
WHERE g.id = 'recaKMBM7D9Bxv662'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
     WHERE id = 'audit_0245_sgp_bundled_gift_split'
  );

-- Move the already-reviewed $25,000 FY2019 allocation intact. This preserves
-- its Massachusetts scope, restriction/designation provenance, and "SGP CBD"
-- purpose note without rewriting any coding fields.
UPDATE gift_allocations
   SET gift_id = 'gift_0245_sgp_direct_25',
       updated_at = now()
 WHERE gift_id = 'recaKMBM7D9Bxv662'
   AND sub_amount = 25000::numeric
   AND grant_year = 'fy2019'
   AND NOT EXISTS (
     SELECT 1 FROM audit_log
      WHERE id = 'audit_0245_sgp_bundled_gift_split'
   );

-- The original record remains the third payment on the pledge. Preserve its
-- original CRM credit date and every non-amount header fact.
UPDATE gifts_and_payments
   SET amount = 300000::numeric,
       updated_at = now()
 WHERE id = 'recaKMBM7D9Bxv662'
   AND amount = 325000::numeric
   AND NOT EXISTS (
     SELECT 1 FROM audit_log
      WHERE id = 'audit_0245_sgp_bundled_gift_split'
   );

-- Restore the existing payment unit/component to the $300,000 amount shown by
-- its untouched QuickBooks source record. Keep every evidence pointer intact.
UPDATE payment_units
   SET gross_amount = 300000::numeric,
       net_amount = CASE
         WHEN net_amount IS NULL THEN NULL
         ELSE 300000::numeric
       END,
       gift_allocation_id = (
         SELECT id
           FROM gift_allocations
          WHERE gift_id = 'recaKMBM7D9Bxv662'
            AND sub_amount = 300000::numeric
       ),
       updated_at = now()
 WHERE id = 'pu_eYUufuwn1mea0hs80eKzK'
   AND gross_amount = 325000::numeric
   AND NOT EXISTS (
     SELECT 1 FROM audit_log
      WHERE id = 'audit_0245_sgp_bundled_gift_split'
   );

UPDATE bank_deposit_components
   SET amount = 300000::numeric,
       updated_at = now()
 WHERE bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2'
   AND payment_unit_id = 'pu_eYUufuwn1mea0hs80eKzK'
   AND amount = 325000::numeric
   AND NOT EXISTS (
     SELECT 1 FROM audit_log
      WHERE id = 'audit_0245_sgp_bundled_gift_split'
   );

-- Represent the additional donor intent as its own manual payment unit within
-- the SAME historical deposit. It deliberately has no QBO source pointer:
-- QuickBooks contains the $300,000 pledge-payment line, not a separate $25,000
-- accounting record.
INSERT INTO payment_units (
  id,
  kind,
  gift_id,
  gift_allocation_id,
  gift_match_method,
  gift_confirmed_by_user_id,
  gift_confirmed_at,
  gift_note,
  created_the_gift,
  gross_amount,
  fee_amount,
  net_amount,
  currency,
  received_date,
  lifecycle,
  bank_deposit_expected,
  created_at,
  updated_at
)
SELECT
  'pu_manual_0245_sgp_direct_25',
  u.kind,
  'gift_0245_sgp_direct_25',
  ga.id,
  'human',
  g.owner_user_id,
  now(),
  'Owner-confirmed $25,000 direct gift bundled with the $300,000 SGP pledge payment; migration 0245.',
  true,
  25000::numeric,
  NULL,
  25000::numeric,
  u.currency,
  u.received_date,
  u.lifecycle,
  u.bank_deposit_expected,
  now(),
  now()
FROM payment_units u
JOIN gifts_and_payments g
  ON g.id = 'gift_0245_sgp_direct_25'
JOIN gift_allocations ga
  ON ga.gift_id = g.id
 AND ga.sub_amount = 25000::numeric
WHERE u.id = 'pu_eYUufuwn1mea0hs80eKzK'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
     WHERE id = 'audit_0245_sgp_bundled_gift_split'
  );

INSERT INTO bank_deposit_components (
  id,
  bank_deposit_id,
  payment_unit_id,
  amount,
  source,
  source_staged_payment_id,
  needs_review,
  ambiguous_deposit_match,
  exclusion_reason,
  classification_source,
  created_at,
  updated_at
)
SELECT
  'bdc_manual_0245_sgp_direct_25',
  d.id,
  u.id,
  25000::numeric,
  'manual',
  NULL,
  false,
  false,
  NULL,
  'manual',
  now(),
  now()
FROM bank_deposits d
JOIN payment_units u
  ON u.id = 'pu_manual_0245_sgp_direct_25'
WHERE d.id = 'bdep_0600314fc0e164a1f15604c2'
  AND NOT EXISTS (
  SELECT 1 FROM audit_log
   WHERE id = 'audit_0245_sgp_bundled_gift_split'
  );

-- Recompute the one persisted pledge rollup from its authoritative active gift
-- rows. It remains $800,000, now for the correct reason.
UPDATE opportunities_and_pledges o
   SET paid = totals.paid,
       updated_at = now()
  FROM (
    SELECT COALESCE(sum(amount), 0)::numeric AS paid
      FROM gifts_and_payments
     WHERE opportunity_id = 'rectelDbOgMh2Ca3y'
       AND archived_at IS NULL
  ) totals
 WHERE o.id = 'rectelDbOgMh2Ca3y'
   AND NOT EXISTS (
     SELECT 1 FROM audit_log
      WHERE id = 'audit_0245_sgp_bundled_gift_split'
   );

INSERT INTO audit_log (
  id,
  actor_user_id,
  action,
  entity_type,
  entity_id,
  summary,
  changes,
  metadata,
  created_at
)
SELECT
  'audit_0245_sgp_bundled_gift_split',
  g.owner_user_id,
  'financial_data_correction',
  'gift',
  'recaKMBM7D9Bxv662',
  'Split the bundled Strategic Grant Partners receipt into a $300,000 pledge payment and a separate $25,000 direct gift',
  jsonb_build_array(
    jsonb_build_object(
      'field', 'gift.amount', 'from', '325000.00', 'to', '300000.00'
    ),
    jsonb_build_object(
      'field', 'gift_allocations',
      'from', '$300,000 + $25,000 on pledge payment',
      'to', '$300,000 on pledge payment + $25,000 on direct gift'
    )
  ),
  jsonb_build_object(
    'migration', '0245_split_strategic_grant_partners_bundled_gift',
    'pledgeId', 'rectelDbOgMh2Ca3y',
    'pledgePaymentGiftId', 'recaKMBM7D9Bxv662',
    'directGiftId', 'gift_0245_sgp_direct_25',
    'bankDepositId', 'bdep_0600314fc0e164a1f15604c2',
    'existingPaymentUnitId', 'pu_eYUufuwn1mea0hs80eKzK',
    'newPaymentUnitId', 'pu_manual_0245_sgp_direct_25',
    'qboStagedPaymentId', 'eYUufuwn1mea0hs80eKzK',
    'bankDepositChanged', false,
    'quickBooksRecordChanged', false
  ),
  now()
FROM gifts_and_payments g
WHERE g.id = 'recaKMBM7D9Bxv662'
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_audit_count integer;
  v_pledge_count integer;
  v_active_pledge_gift_count integer;
  v_active_pledge_gift_total numeric;
  v_original_gift_count integer;
  v_original_allocation_count integer;
  v_original_allocation_total numeric;
  v_direct_gift_count integer;
  v_direct_allocation_count integer;
  v_direct_allocation_total numeric;
  v_existing_unit_count integer;
  v_direct_unit_count integer;
  v_existing_component_count integer;
  v_direct_component_count integer;
  v_deposit_component_count integer;
  v_deposit_component_total numeric;
  v_excluded_1500_count integer;
  v_staged_payment_count integer;
  v_deposit_count integer;
BEGIN
  SELECT count(*)::integer
    INTO v_audit_count
    FROM audit_log
   WHERE id = 'audit_0245_sgp_bundled_gift_split'
     AND action = 'financial_data_correction'
     AND entity_type = 'gift'
     AND entity_id = 'recaKMBM7D9Bxv662'
     AND metadata ->> 'migration'
         = '0245_split_strategic_grant_partners_bundled_gift';

  SELECT count(*)::integer
    INTO v_pledge_count
    FROM opportunities_and_pledges
   WHERE id = 'rectelDbOgMh2Ca3y'
     AND archived_at IS NULL
     AND awarded_amount = 800000::numeric
     AND paid = 800000::numeric;

  SELECT count(*)::integer, COALESCE(sum(amount), 0)
    INTO v_active_pledge_gift_count, v_active_pledge_gift_total
    FROM gifts_and_payments
   WHERE opportunity_id = 'rectelDbOgMh2Ca3y'
     AND archived_at IS NULL;

  SELECT count(*)::integer
    INTO v_original_gift_count
    FROM gifts_and_payments
   WHERE id = 'recaKMBM7D9Bxv662'
     AND opportunity_id = 'rectelDbOgMh2Ca3y'
     AND amount = 300000::numeric
     AND date_received = DATE '2017-06-07'
     AND archived_at IS NULL;

  SELECT count(*)::integer, COALESCE(sum(sub_amount), 0)
    INTO v_original_allocation_count, v_original_allocation_total
    FROM gift_allocations
   WHERE gift_id = 'recaKMBM7D9Bxv662';

  SELECT count(*)::integer
    INTO v_direct_gift_count
    FROM gifts_and_payments d
    JOIN gifts_and_payments p ON p.id = 'recaKMBM7D9Bxv662'
   WHERE d.id = 'gift_0245_sgp_direct_25'
     AND d.opportunity_id IS NULL
     AND d.organization_id IS NOT DISTINCT FROM p.organization_id
     AND d.individual_giver_person_id IS NOT DISTINCT FROM p.individual_giver_person_id
     AND d.household_id IS NOT DISTINCT FROM p.household_id
     AND d.amount = 25000::numeric
     AND d.date_received = p.date_received
     AND d.archived_at IS NULL;

  SELECT count(*)::integer, COALESCE(sum(sub_amount), 0)
    INTO v_direct_allocation_count, v_direct_allocation_total
    FROM gift_allocations
   WHERE gift_id = 'gift_0245_sgp_direct_25'
     AND grant_year = 'fy2019';

  SELECT count(*)::integer
    INTO v_existing_unit_count
    FROM payment_units
   WHERE id = 'pu_eYUufuwn1mea0hs80eKzK'
     AND gift_id = 'recaKMBM7D9Bxv662'
     AND gift_allocation_id IN (
       SELECT id FROM gift_allocations
        WHERE gift_id = 'recaKMBM7D9Bxv662'
          AND sub_amount = 300000::numeric
     )
     AND gross_amount = 300000::numeric
     AND (net_amount IS NULL OR net_amount = 300000::numeric)
     AND source_staged_payment_id = 'eYUufuwn1mea0hs80eKzK'
     AND received_date = DATE '2018-09-06';

  SELECT count(*)::integer
    INTO v_direct_unit_count
    FROM payment_units
   WHERE id = 'pu_manual_0245_sgp_direct_25'
     AND gift_id = 'gift_0245_sgp_direct_25'
     AND gift_allocation_id IN (
       SELECT id FROM gift_allocations
        WHERE gift_id = 'gift_0245_sgp_direct_25'
          AND sub_amount = 25000::numeric
     )
     AND source_staged_payment_id IS NULL
     AND stripe_charge_id IS NULL
     AND donorbox_donation_id IS NULL
     AND gross_amount = 25000::numeric
     AND net_amount = 25000::numeric
     AND received_date = DATE '2018-09-06'
     AND lifecycle = 'received';

  SELECT count(*)::integer
    INTO v_existing_component_count
    FROM bank_deposit_components
   WHERE bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2'
     AND payment_unit_id = 'pu_eYUufuwn1mea0hs80eKzK'
     AND amount = 300000::numeric
     AND exclusion_reason IS NULL;

  SELECT count(*)::integer
    INTO v_direct_component_count
    FROM bank_deposit_components
   WHERE id = 'bdc_manual_0245_sgp_direct_25'
     AND bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2'
     AND payment_unit_id = 'pu_manual_0245_sgp_direct_25'
     AND amount = 25000::numeric
     AND source = 'manual'
     AND source_staged_payment_id IS NULL
     AND exclusion_reason IS NULL;

  SELECT
    count(*)::integer,
    COALESCE(sum(amount), 0),
    count(*) FILTER (
      WHERE amount = 1500::numeric
        AND exclusion_reason IS NOT NULL
    )::integer
    INTO
      v_deposit_component_count,
      v_deposit_component_total,
      v_excluded_1500_count
    FROM bank_deposit_components
   WHERE bank_deposit_id = 'bdep_0600314fc0e164a1f15604c2';

  -- These are deliberately read-only source-history checks: neither table is
  -- updated anywhere in this migration.
  SELECT count(*)::integer
    INTO v_staged_payment_count
    FROM staged_payments
   WHERE id = 'eYUufuwn1mea0hs80eKzK'
     AND amount = 300000::numeric
     AND date_received = DATE '2018-09-06';

  SELECT count(*)::integer
    INTO v_deposit_count
    FROM bank_deposits
   WHERE id = 'bdep_0600314fc0e164a1f15604c2'
     AND amount = 326500::numeric
     AND deposit_date = DATE '2018-09-06';

  IF v_audit_count <> 1 THEN
    RAISE EXCEPTION
      '0245 postflight: expected one matching migration audit row, found %',
      v_audit_count;
  END IF;

  IF v_pledge_count <> 1
     OR v_active_pledge_gift_count <> 3
     OR v_active_pledge_gift_total <> 800000::numeric THEN
    RAISE EXCEPTION
      '0245 postflight: pledge is not $800,000 paid by exactly 3 active gifts (count %, total %)',
      v_active_pledge_gift_count, v_active_pledge_gift_total;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM gifts_and_payments
     WHERE id = 'recYYkpHXjHh2n7g6'
       AND opportunity_id = 'rectelDbOgMh2Ca3y'
       AND amount = 400000::numeric
       AND archived_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM gifts_and_payments
     WHERE id = 'rec6elo1J3tNAoAjs'
       AND opportunity_id = 'rectelDbOgMh2Ca3y'
       AND amount = 100000::numeric
       AND archived_at IS NULL
  ) OR v_original_gift_count <> 1 THEN
    RAISE EXCEPTION
      '0245 postflight: pledge payments are not exactly $400,000 + $100,000 + $300,000';
  END IF;

  IF v_original_allocation_count <> 1
     OR v_original_allocation_total <> 300000::numeric
     OR v_direct_gift_count <> 1
     OR v_direct_allocation_count <> 1
     OR v_direct_allocation_total <> 25000::numeric THEN
    RAISE EXCEPTION
      '0245 postflight: the $300,000 pledge allocation / $25,000 direct-gift allocation split is invalid';
  END IF;

  IF v_existing_unit_count <> 1
     OR v_direct_unit_count <> 1
     OR v_existing_component_count <> 1
     OR v_direct_component_count <> 1 THEN
    RAISE EXCEPTION
      '0245 postflight: payment-unit/component split is invalid';
  END IF;

  IF v_deposit_count <> 1
     OR v_deposit_component_count <> 3
     OR v_deposit_component_total <> 326500::numeric
     OR v_excluded_1500_count <> 1 THEN
    RAISE EXCEPTION
      '0245 postflight: historical deposit changed or composition does not total $326,500 with the excluded $1,500 intact (count %, total %, excluded-1500 count %)',
      v_deposit_component_count, v_deposit_component_total,
      v_excluded_1500_count;
  END IF;

  IF v_staged_payment_count <> 1 THEN
    RAISE EXCEPTION
      '0245 postflight: the source $300,000 QuickBooks record changed';
  END IF;

  RAISE NOTICE
    '0245: SGP verified — $800,000 pledge paid $400,000 + $100,000 + $300,000; separate $25,000 direct gift; $326,500 deposit and $300,000 QBO record preserved';
END $$;
