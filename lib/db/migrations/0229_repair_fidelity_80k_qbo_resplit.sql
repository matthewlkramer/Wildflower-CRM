-- 0229: Repair the Fidelity $80k QBO Deposit re-split (2025-12-30).
--
-- QBO changed one already gift-linked $80,000 Deposit line into two current
-- accounting lines ($65,000 school grant + $15,000 operations guide). The bank
-- composition is correct, but the old unit retained gross_amount=80000 and the
-- new $15,000 unit had no gift_id, so the workbench rendered a false "Needs CRM
-- gift" card beside the one correct $80,000 multi-allocation gift.
--
-- Safe/idempotent: this file acts only on the exact deposit+gift pair, aborts
-- unless the live source/component shape is exactly the reviewed 65k+15k
-- same-payer QBO split, and accepts both the pre-repair and already-repaired
-- gift-pointer states. It creates/deletes no records.
--
-- From the repository root (production is human-applied):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0229_repair_fidelity_80k_qbo_resplit.sql

DO $$
DECLARE
  v_deposit_count integer;
  v_component_count integer;
  v_component_total numeric;
  v_amount_shape_count integer;
  v_bad_component_count integer;
  v_bad_source_count integer;
  v_missing_payer_count integer;
  v_payer_count integer;
  v_realm_count integer;
  v_qbo_deposit_count integer;
  v_expected_gift_links integer;
  v_other_gift_links integer;
BEGIN
  SELECT count(*) INTO v_deposit_count
  FROM bank_deposits
  WHERE id = 'bdep_fdaf5e42f6f5ac0556ce564b';

  -- Development may not contain this production-only historical row. Applying
  -- the migration there is still required and intentionally becomes a no-op.
  IF v_deposit_count = 0 THEN
    RAISE NOTICE '0229: target Fidelity deposit is absent; no-op';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM bank_deposits
    WHERE id = 'bdep_fdaf5e42f6f5ac0556ce564b'
      AND deposit_date = DATE '2025-12-30'
      AND amount = 80000.00
  ) THEN
    RAISE EXCEPTION '0229 preflight: target deposit date/amount changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM gifts_and_payments
    WHERE id = 'reccnVv6dWZCMjS8J'
      AND amount = 80000.00
      AND archived_at IS NULL
  ) THEN
    RAISE EXCEPTION '0229 preflight: target $80k gift is missing, changed, or archived';
  END IF;

  SELECT
    count(*)::integer,
    COALESCE(sum(component.amount), 0),
    count(*) FILTER (WHERE component.amount IN (15000.00, 65000.00))::integer,
    count(*) FILTER (
      WHERE component.source <> 'qbo_inferred'
         OR component.exclusion_reason IS NOT NULL
         OR component.needs_review
         OR component.ambiguous_deposit_match
    )::integer,
    count(*) FILTER (
      WHERE component.source_staged_payment_id IS NULL
         OR unit.source_staged_payment_id IS DISTINCT FROM component.source_staged_payment_id
         OR staged.id IS NULL
         OR staged.amount IS DISTINCT FROM component.amount
    )::integer,
    count(*) FILTER (WHERE NULLIF(trim(staged.payer_name), '') IS NULL)::integer,
    count(DISTINCT lower(regexp_replace(trim(staged.payer_name), '\s+', ' ', 'g')))::integer,
    count(DISTINCT staged.realm_id)::integer,
    count(DISTINCT staged.qb_deposit_id)::integer,
    count(*) FILTER (WHERE unit.gift_id = 'reccnVv6dWZCMjS8J')::integer,
    count(*) FILTER (
      WHERE unit.gift_id IS NOT NULL
        AND unit.gift_id <> 'reccnVv6dWZCMjS8J'
    )::integer
  INTO
    v_component_count,
    v_component_total,
    v_amount_shape_count,
    v_bad_component_count,
    v_bad_source_count,
    v_missing_payer_count,
    v_payer_count,
    v_realm_count,
    v_qbo_deposit_count,
    v_expected_gift_links,
    v_other_gift_links
  FROM bank_deposit_components component
  JOIN payment_units unit ON unit.id = component.payment_unit_id
  LEFT JOIN staged_payments staged
    ON staged.id = component.source_staged_payment_id
  WHERE component.bank_deposit_id = 'bdep_fdaf5e42f6f5ac0556ce564b';

  IF v_component_count <> 2
     OR v_component_total <> 80000.00
     OR v_amount_shape_count <> 2
     OR v_bad_component_count <> 0
     OR v_bad_source_count <> 0
     OR v_missing_payer_count <> 0
     OR v_payer_count <> 1
     OR v_realm_count <> 1
     OR v_qbo_deposit_count <> 1
     OR v_expected_gift_links < 1
     OR v_other_gift_links <> 0 THEN
    RAISE EXCEPTION
      '0229 preflight: unexpected shape components=% total=% amount_shape=% bad_components=% bad_sources=% missing_payers=% payers=% realms=% qbo_deposits=% expected_gift_links=% other_gift_links=%',
      v_component_count, v_component_total, v_amount_shape_count,
      v_bad_component_count, v_bad_source_count, v_missing_payer_count,
      v_payer_count, v_realm_count, v_qbo_deposit_count,
      v_expected_gift_links, v_other_gift_links;
  END IF;

  UPDATE payment_units unit
  SET gross_amount = component.amount,
      net_amount = component.amount,
      gift_id = 'reccnVv6dWZCMjS8J',
      gift_match_method = CASE
        WHEN unit.gift_id IS NULL THEN 'system_confirmed'::payment_application_match_method
        ELSE unit.gift_match_method
      END,
      gift_confirmed_by_user_id = CASE
        WHEN unit.gift_id IS NULL THEN NULL
        ELSE unit.gift_confirmed_by_user_id
      END,
      gift_confirmed_at = CASE
        WHEN unit.gift_id IS NULL THEN now()
        ELSE unit.gift_confirmed_at
      END,
      gift_note = CASE
        WHEN unit.gift_id IS NULL THEN COALESCE(
          unit.gift_note,
          'Carried from the reviewed Fidelity QBO Deposit split (migration 0229)'
        )
        ELSE unit.gift_note
      END,
      created_the_gift = CASE
        WHEN unit.gift_id IS NULL THEN false
        ELSE unit.created_the_gift
      END,
      updated_at = now()
  FROM bank_deposit_components component
  WHERE component.bank_deposit_id = 'bdep_fdaf5e42f6f5ac0556ce564b'
    AND unit.id = component.payment_unit_id
    AND (
      unit.gross_amount IS DISTINCT FROM component.amount
      OR unit.net_amount IS DISTINCT FROM component.amount
      OR unit.gift_id IS DISTINCT FROM 'reccnVv6dWZCMjS8J'
    );

  IF NOT EXISTS (
    SELECT 1
    FROM bank_deposits deposit
    WHERE deposit.id = 'bdep_fdaf5e42f6f5ac0556ce564b'
      AND deposit.amount = (
        SELECT sum(component.amount)
        FROM bank_deposit_components component
        WHERE component.bank_deposit_id = deposit.id
      )
      AND deposit.amount = (
        SELECT sum(unit.gross_amount)
        FROM bank_deposit_components component
        JOIN payment_units unit ON unit.id = component.payment_unit_id
        WHERE component.bank_deposit_id = deposit.id
          AND unit.gift_id = 'reccnVv6dWZCMjS8J'
      )
      AND 2 = (
        SELECT count(*)
        FROM bank_deposit_components component
        JOIN payment_units unit ON unit.id = component.payment_unit_id
        WHERE component.bank_deposit_id = deposit.id
          AND unit.gift_id = 'reccnVv6dWZCMjS8J'
          AND unit.gross_amount = component.amount
          AND unit.net_amount = component.amount
      )
  ) THEN
    RAISE EXCEPTION '0229 postflight: repaired components/units/gift do not reconcile to $80k';
  END IF;

  RAISE NOTICE '0229: Fidelity $80k QBO split repaired and verified';
END $$;
