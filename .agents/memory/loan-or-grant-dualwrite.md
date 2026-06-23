---
name: loan_or_grant authoritative flag
description: The single loan|grant enum replacing three scattered legacy classification signals, and the phased dual-write→parity→read-flip rollout that protects it.
---

# loan_or_grant authoritative flag

`loan_or_grant` (Postgres enum `loan` | `grant`) is the single authoritative
money-classification flag on `gifts_and_payments`,
`opportunities_and_pledges`, and `fiscal_year_entity_goals`. It replaces THREE
scattered legacy signals that previously meant the same thing:
- opportunities: `fundraising_category` (`revenue` | `loan_capital`)
- gifts: derived from `type = 'loan_fund_investment'`
- goals: the `category` segment of the `fiscal_year_entity_goals` PK

Semantic map (1:1): `loan_capital` / `loan_fund_investment` → `loan`; `revenue`
and everything else → `grant`. Caveat: `grant` means "all non-loan money"
(including individual donations), NOT literally grant-maker grants.

**Rule:** while both the legacy signal and `loan_or_grant` coexist, EVERY write
path that sets a legacy classification signal must ALSO mirror `loanOrGrant` in
the same write — opp create/patch (from `fundraisingCategory`), gift
create/patch (from `type`), goals upsert insert+onConflict (from the
`:category` path param), gift bulk-update (only when `type` is in the patch,
via the `deriveColumns` hook so the mirror lands in the same atomic UPDATE), and
the two gift→pledge transforms (split-into-pledge carries the source gift's
flag onto the pledge + every minted payment gift; merge-into-pledge =
any-source-loan ⇒ loan). A patch that does NOT touch the legacy signal must NOT
reset the mirror.

**Why:** with reads still on the legacy column (phase A001), a missed mirror is
invisible until reads flip (A002) — then that row silently classifies wrong.
This is the same drift trap as gift-qb-tie-status and driver-tree cache keys: a
derived-but-persisted field goes stale the instant one writer forgets it.

**How to apply:** the mappers live in `@workspace/api-zod`
(`legacyCategoryToLoanOrGrant`, `loanOrGrantToLegacyCategory`,
`giftTypeToLoanOrGrant`) and are pure/env-neutral (imported by both server and
browser — keep them free of node/DOM/URL globals). When you add ANY new write
path that sets `fundraising_category`/gift `type`/goals `category`, mirror
`loanOrGrant` there too, and add a case to
`artifacts/api-server/src/__tests__/loan-or-grant-dualwrite.integration.test.ts`.

**Rollout discipline (mirrors the payment_applications ledger rollout):**
- A001 — additive: enum + `NOT NULL DEFAULT 'grant'` columns + mappers +
  dual-write + idempotent backfill. Legacy stays the READ source. DONE.
- A002 — parity gate (legacy rollups == loan_or_grant rollups for
  dashboard-summary / fiscal-year-breakdown / projections / goals /
  revenue-coding) THEN flip reads (analytics.ts, fiscalYearEntityGoals.ts route,
  revenue-coding.ts) contract-first (expose `loanOrGrant`; goals `:category`
  accepts new `loan`/`grant` tokens alongside old). Keep dual-write + legacy
  cols for rollback. Human PROD GATE: apply schema+backfill SQL to prod, run
  parity vs prod, zero drift, then Publish flipped reads.
- A003 — deprecate (not drop) the legacy signals after one full prod cycle;
  consider goals PK → `(fy, entity, loan_or_grant)`.

Constraints that bound this work: agent cannot write prod (schema ships as
additive idempotent hand-applied SQL in `lib/db/migrations/`, NOT Publish —
Publish aborts on the pre-existing `opportunities.conditions_met` drift; prod
data via reviewed idempotent SQL run by a human). Pledge `paid_amount` and the
`payment_applications` ledger are out of scope — do not touch.
