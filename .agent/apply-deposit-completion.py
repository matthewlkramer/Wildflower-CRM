from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


route_path = Path("artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts")
route = route_path.read_text(encoding="utf-8")

route = replace_once(
    route,
    '''import {
  lensFlagsFromState,
  rowCompleteFromState,
  type CrmCardEntry,''',
    '''import {
  lensFlagsFromState,
  type CrmCardEntry,''',
    "remove generic completion import",
)
route = replace_once(
    route,
    '''import { deriveDepositWorkbenchState } from "./workbenchDepositState";''',
    '''import {
  depositCompleteFromState,
  deriveDepositWorkbenchState,
} from "./workbenchDepositState";''',
    "deposit completion import",
)
route = replace_once(
    route,
    '''  const canonical = lensFlagsFromState(state);
  if (!flags.f_completed && !flags.f_not_fundraising) out.push("all_open");''',
    '''  const canonical = lensFlagsFromState(state);
  const completed = depositCompleteFromState(state);
  if (!completed && !flags.f_not_fundraising) out.push("all_open");''',
    "canonical completed lens start",
)
route = replace_once(
    route,
    '''  if (flags.f_completed) out.push("completed");''',
    '''  if (completed) out.push("completed");''',
    "canonical completed lens end",
)
route = replace_once(
    route,
    '''        AND NOT f_needs_gift
        AND NOT f_correction
        AND NOT f_refund''',
    '''        AND NOT f_needs_gift
        AND NOT f_crm_incomplete
        AND NOT f_missing_accounting
        AND NOT f_correction
        AND NOT f_refund''',
    "completed SQL blockers",
)
route = replace_once(
    route,
    '''      ) AS f_needs_gift,
      EXISTS (
        SELECT 1
        FROM qbo_accounting_checks qc''',
    '''      ) AS f_needs_gift,
      EXISTS (
        SELECT 1
        FROM payment_units crm_unit
        JOIN gifts_and_payments crm_gift ON crm_gift.id = crm_unit.gift_id
        WHERE crm_gift.archived_at IS NULL
          AND (
            (
              p.id IS NOT NULL
              AND crm_unit.stripe_charge_id IN (
                SELECT crm_charge.id
                FROM stripe_staged_charges crm_charge
                WHERE crm_charge.stripe_payout_id = p.id
                  AND crm_charge.raw_charge->>'status' = 'succeeded'
                  AND crm_charge.exclusion_reason IS NULL
                  AND NOT (
                    crm_charge.refunded = true
                    AND COALESCE(crm_charge.amount_refunded, 0) >= crm_charge.gross_amount
                  )
              )
            )
            OR (
              p.id IS NULL
              AND crm_unit.id IN (
                SELECT crm_component.payment_unit_id
                FROM bank_deposit_components crm_component
                WHERE crm_component.bank_deposit_id = d.id
                  AND crm_component.exclusion_reason IS NULL
              )
            )
          )
          AND (
            (
              crm_gift.organization_id IS NULL
              AND crm_gift.individual_giver_person_id IS NULL
              AND crm_gift.household_id IS NULL
            )
            OR NOT EXISTS (
              SELECT 1
              FROM gift_allocations crm_allocation
              WHERE crm_allocation.gift_id = crm_gift.id
            )
          )
      ) AS f_crm_incomplete,
      NOT (
        EXISTS (
          SELECT 1
          FROM bank_deposit_components accounting_component
          JOIN payment_units accounting_unit
            ON accounting_unit.id = accounting_component.payment_unit_id
          WHERE accounting_component.bank_deposit_id = d.id
            AND accounting_component.exclusion_reason IS NULL
            AND accounting_unit.source_staged_payment_id IS NOT NULL
        )
        OR EXISTS (
          SELECT 1
          FROM source_links accounting_line
          WHERE accounting_line.link_type = 'qbo_line_deposit'
            AND accounting_line.bank_deposit_id = d.id
        )
        OR EXISTS (
          SELECT 1
          FROM source_links accounting_register
          WHERE accounting_register.link_type = 'qbo_register_deposit'
            AND accounting_register.bank_deposit_id = d.id
        )
        OR EXISTS (
          SELECT 1
          FROM source_links accounting_settlement
          JOIN stripe_payouts accounting_payout
            ON accounting_payout.id = accounting_settlement.stripe_payout_id
          WHERE accounting_settlement.link_type = 'payout_qb_settlement'
            AND accounting_payout.bank_deposit_id = d.id
        )
      ) AS f_missing_accounting,
      EXISTS (
        SELECT 1
        FROM qbo_accounting_checks qc''',
    "CRM and accounting completion SQL",
)
route = replace_once(
    route,
    '''            complete: rowCompleteFromState(state),''',
    '''            complete: depositCompleteFromState(state),''',
    "deposit coverage complete",
)
route_path.write_text(route, encoding="utf-8")

integration_path = Path(
    "artifacts/api-server/src/__tests__/workbench-deposit-completion.integration.test.ts"
)
integration = integration_path.read_text(encoding="utf-8")
count = integration.count('status: "audit_ready"')
if count != 2:
    raise SystemExit(f"integration status expectations: expected 2, found {count}")
integration = integration.replace('status: "audit_ready"', 'status: "accounting_pending"')
integration_path.write_text(integration, encoding="utf-8")

print("deposit completion patch applied")
