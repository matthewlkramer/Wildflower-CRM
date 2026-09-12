# 0249 — CRM-native reporting requirement

## Purpose

Adds `opportunities_and_pledges.reporting_required` as the live source of truth
for whether an opportunity or award requires donor reporting. This removes the
bookable-gift and accounting-export dependency on historical coding-form staging
rows.

## Publish

Run `0249_crm_native_reporting_requirement.sql` through the normal migration
workflow before deploying the application build that reads this field.

The new column is nullable and has no default. `NULL` means “not yet reviewed”;
it does not invent a reporting answer for historical opportunities. Historical
values will be set only through the reviewed donation-coding correction
migration after the worksheet decisions are complete. New opportunities created
through the CRM must make an explicit yes/no choice.

## Verification

1. Confirm the column exists, is nullable, and has no default.
2. In the CRM, mark a test opportunity as requiring reporting.
3. Confirm its linked gift appears as incomplete until at least one Reporting
   Deadline task exists.
4. Confirm the accounting export preview is blocked by that missing deadline and
   becomes exportable after the deadline is recorded.

## Rollback

Do not drop the column after application code depends on it. Roll back the
application build first; only then may the column be dropped if no reviewed data
has been entered.
