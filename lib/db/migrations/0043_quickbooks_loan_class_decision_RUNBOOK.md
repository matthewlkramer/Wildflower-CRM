# 0043 — Loan-by-CLASS decision (NO-GO, no migration)

## TL;DR

**Decision: do NOT auto-exclude QuickBooks payments by a loan marker on their
`line_classes`.** There is no SQL backfill and no classifier change to scan
classes — this file is the recorded decision for the follow-up flagged by `0042`.
Class-only loan rows (e.g. the $75k "Flor do Loto" deposit) **stay a manual
exclusion**, which remains the intended handling.

A regression unit test (`"does NOT exclude a row whose only loan marker is on the
QuickBooks class"` in `artifacts/api-server/src/__tests__/quickbooks-exclusion-rules.test.ts`)
locks the decision in, and the rationale is mirrored in the `isLoanLineOrText`
doc comment in `artifacts/api-server/src/lib/quickbooksExclusionRules.ts`.

## The question

`0033` / `0042` swept loans whose "loan/repayment" marker sits on the line item,
posting account, line description, or reference. One real row carries the marker
**only on its QuickBooks line Class**:

> `xBe80JHAOO0pyt6c5uVlh` (qb_entity_id 24643) — $75,000 deposit from
> "Flor De Loto Montessori Corp", posted to **"702 Grants to Schools"**, class
> **"National (deleted):Loans (deleted)"**. Neither the payer, the account, nor
> the memo carries a loan word — the class is the only loan signal. It is in the
> queue only because a human excluded it by hand (`classification_source='manual'`).

`isLoanLineOrText` deliberately does not scan `line_classes`. The task: decide
against **real prod class values** whether scanning the class is safe, and if so
for which exact markers.

## Evidence (prod, read-only, 2026-06-17)

Distinct `line_classes` values carrying a loan word (`~* '\m(loans?|repayment)\M'`):

| class value | rows | safe loan marker? |
|---|---|---|
| `Loan Payment (deleted)` | 209 | yes — 209/209 are loan noise, **zero** counterexamples; but **all 209 are already auto-excluded by the existing payer/line rules**, so scanning this class catches nothing new. |
| `National (deleted):Loans (deleted)` | 10 | **NO** — see below. |

No other class value contains "loan"/"repayment", so a class scan would only ever
touch these two buckets today.

### Why the `…:Loans` bucket is unsafe

The 10 rows in `National (deleted):Loans (deleted)`:

| status | amount | posting account | what it is |
|---|---|---|---|
| **approved** | **$500,000** | `2510 US Bank (Sunlight)` (liability) | **tracked gift** "US Bank CDFI loan", type `loan_fund_investment`, U.S. Bank Foundation — a fundraiser **matched** it to an existing CRM gift (`rec0JBK74STZ1BxJY`) |
| excluded (manual) | $150,000 | `1600 Loans to Schools` | WNYCS school-loan repayment |
| excluded (manual) | $75,000 | `702 Grants to Schools` | **Flor do Loto** — the reported class-only row |
| excluded (auto) ×7 | various | `1600 Loans to Schools` / `702.x Grants to Schools` / `Interest Earned` | school-loan disbursements / repayments / a zero-amount row |

The same class bucket holds **both**:

- school-loan repayments the org does **not** track as gifts (noise — should be
  excluded), **and**
- a $500k **loan-fund investment** the org **does** track and reconcile (a real
  `loan_fund_investment` gift, deliberately matched by a human).

There is no class-level signal that separates the two. The donation-first guard
does not help either — neither shape carries a `4000`/`4100` donation line. Auto-
excluding the `…:Loans` class would therefore wrongly hide money the org actively
reviews, violating the project's core rule ("never wrongly hide a real gift").

### Why "Loan Payment" alone is not worth shipping

`Loan Payment (deleted)` is a clean marker (100% loan noise), but every one of
its 209 rows is **already** excluded by the existing payer/line rules — scanning
it as a class catches nothing new, and it does **not** cover the reported
Flor-do-Loto case (which is in the `…:Loans` bucket). Adding a curated
"safe loan class" allowlist would add maintenance surface for zero current
benefit, so it is intentionally left out.

## Decision

**NO** — `line_classes` is not scanned for loan markers. The `…:Loans` bucket is
ambiguous (mixes tracked loan-fund investments with noise) and the only
unambiguous class (`Loan Payment`) adds nothing. Class-only loan rows stay a
**manual** exclusion. This matches the out-of-scope note already in
`0042_quickbooks_loan_line_resweep_RUNBOOK.md`.

If a future need arises, the safe path is NOT a broad class scan but a narrow,
curated allowlist of confirmed pure-loan-repayment class names — and only after
re-checking prod that no `loan_fund_investment` / matched-gift row shares the
class. Keep any such allowlist in lockstep across the TS classifier and a paired
SQL backfill (the `0042` pattern).

## Apply

Nothing to apply — this is a documented no-go decision, not a migration.
