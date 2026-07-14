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

**Current state (A003 cutover COMPLETE, 2026-07):** the dual-write has ENDED.
`loan_or_grant` is the ONLY signal read or written for opps and goals; the goals
PK is now `(fiscal_year_id, entity_id, loan_or_grant)`. Legacy
`fundraising_category` / goals `category` columns are `@deprecated` — physical
only, never written, never read, scrubbed from every API response via explicit
column projections (`goalResponseColumns` / `oppHeaderColumns`). Gift `type` is
still real (not legacy) and still derives `loanOrGrant` via
`giftTypeToLoanOrGrant` on gift writes.

**Rules that survive the cutover:**
- Never reintroduce a write to `fundraising_category`/goals `category`; a new
  full-row opp/goal select that reaches the client leaks the deprecated column
  (no Zod stripping) — route responses through the scrub projections.
- Goals `:category` path param accepts BOTH token families (`loan`/`grant` and
  legacy `loan_capital`/`revenue`), normalized to `loan_or_grant`.
- The mappers in `@workspace/api-zod` stay env-neutral;
  `legacyCategoryToLoanOrGrant`/`loanOrGrantToLegacyCategory` remain only for
  the HISTORICAL parity script (post-cutover drift vs frozen legacy columns is
  expected, not a bug).

**Why:** `grant` means "all non-loan money" (including individual donations),
NOT literally grant-maker grants — keep that caveat when naming UI options.

Prod path: goals PK swap ships as idempotent hand-applied
`lib/db/migrations/0120_goals_pk_loan_or_grant.sql` (+ runbook) BEFORE/with the
Publish that stops dual-writing; agent cannot write prod.

Constraints that bound this work: agent cannot write prod (schema ships as
additive idempotent hand-applied SQL in `lib/db/migrations/`, NOT Publish —
Publish aborts on the pre-existing `opportunities.conditions_met` drift; prod
data via reviewed idempotent SQL run by a human). Pledge `paid_amount` and the
`payment_applications` ledger are out of scope — do not touch.
