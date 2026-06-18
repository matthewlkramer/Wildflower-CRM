# 0046 — QuickBooks earned-income-by-account-NAME

## What & why

Follow-up to **0045**. After 0045 shipped, fees-for-service deposits were **still**
sitting in the **QuickBooks Review** queue (the "DC" school records — *DC
Wildflower Public Charter School*, *Wild Rose Montessori*, *Ginkgo*, *Violeta
Montessori*, etc.).

Diagnosis from the live queue: these rows are coded to the income account by its
**NAME** — the bare **`Services - Earned Income`** — with **no leading `4020`
code**, and their memo / line description are empty (or just `"Paid via QuickBooks
Payments: Payment ID …"`). QuickBooks emits the same income account both **with**
and **without** its leading code, so the `4020`-prefix match (0040) **and** the
memo-phrase match (0045) both missed the code-less variant — which turned out to
be the dominant shape in the queue. That is why 0045 reported "only one update"
(Part A updated the rule; Part B matched **0** rows).

The classifier now **also** matches an `"earned income"` / `"service income"`
whole-word phrase on the account **NAME**, folded into the **same**
`earned_income` reason and the **same** donation-first guard. No new enum value,
no OpenAPI/UI change.

> **The payer / customer NAME is deliberately NOT matched.** Several rows have
> "Service Revenue" in the *payer* name (e.g. *DC Wildflower PCS - Service
> Revenue*) but are real **grants** (4030 Other Revenue, Charter Fund) or
> **donations** — matching the payer name would wrongly hide them. Only the
> account name / memo / line description are tested.

## Code (ships via Publish)

- `quickbooksExclusionRules.ts` — `EARNED_INCOME_MEMO_PATTERNS` renamed to
  `EARNED_INCOME_PHRASE_PATTERNS`; `isEarnedIncomeLine` now also tests the account
  **names** (joined with a space, mirroring the engine's multi-value regex) for an
  earned/service-income phrase.
- `quickbooksRules.ts` — `SEED_RULES.seed_earned_income` gains a fourth condition:
  a `line_account_name` **regex** (match_logic stays `any`, `donation_guard` on).
- Tests: `quickbooks-exclusion-rules.test.ts` (bare account-name positive,
  `unearned income` negative, "Service Revenue" payer negative, donation-guard)
  and `quickbooks-rules-fidelity.test.ts` (same fixtures, seed/classifier parity).

> **Important:** the code change alone is **not enough** in production. New pulls
> are classified by the DB-backed `quickbooks_handling_rules` table, not the
> in-code `SEED_RULES`; the existing review queue is never auto-reclassified. Both
> need the SQL below. Publish ships the *code* but never runs this file.

## Migration (human-run on prod)

`0046_quickbooks_earned_income_account_name_backfill.sql` has **two idempotent
parts** in one transaction:

- **Part A — ingest rule.** Appends the `line_account_name` regex condition to the
  persisted `seed_earned_income` row so **new** pulls auto-exclude. The guard
  accepts **both** the original 0040 single-`4020` shape **and** the post-0045
  three-condition shape, so it applies whether or not 0045 was run on this DB.
- **Part B — backfill.** Re-runs the refined rule over the **existing** queue,
  marking earned-income rows (incl. the bare account-name variant) `excluded`.

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0046_quickbooks_earned_income_account_name_backfill.sql
```

### Safety

- **Part A** fires only when `seed_earned_income` still holds a **known canonical
  shape** (original 0040 *or* post-0045) **and** `action='exclude'`,
  `exclusion_reason='earned_income'`, `donation_guard=true`, `match_logic='any'`.
  Any admin customisation → Part A skips the row (add the condition from the admin
  page). Re-running is a no-op (the final four-condition shape isn't in the guard
  list).
- **Part B** touches only rows currently `status = 'pending'` **and**
  `classification_source = 'auto'` — approved / rejected / already-excluded /
  manually re-included rows are never modified.
- **Donation-first guarded** — never excludes a deposit that also carries a real
  donation line (a 4000/4100 donation account or a "Donation" item). This is what
  keeps the *DC Wildflower PCS - Service Revenue* donation / grant rows as gifts.
- Word-anchored (`\m…\M`) so `"unearned income"` cannot match.
- Idempotent — re-running is a no-op. Nothing is deleted.

### TS ⇄ engine ⇄ SQL lockstep

| classifier (TS)                              | seed rule (JSONB) / SQL backfill                |
| -------------------------------------------- | ----------------------------------------------- |
| `EARNED_INCOME_PHRASE_PATTERNS` per-field over `rawReference`, `lineDescription` | `{"field":"memo_reference"\|"line_description","mode":"regex","value":"\\bearned income\\b\|\\bservice income\\b"}` / `~* '\m(earned\|service) income\M'` per column |
| same patterns over `lineAccountNames.join(" ")` | `{"field":"line_account_name","mode":"regex","value":"\\bearned income\\b\|\\bservice income\\b"}` / `array_to_string(line_account_names,' ') ~* '\m(earned\|service) income\M'` |
| `EARNED_INCOME_ACCOUNT_CODE_PREFIXES = ["4020"]` | `{"field":"line_account_name","mode":"prefix","value":"4020"}` / per-element `LIKE '4020%'` |
| donation-first guard (4000/4100 account, "donation" item) | `donation_guard: true` / `NOT EXISTS … LIKE '4000%'/'4100%'`, `NOT EXISTS … LIKE '%donation%'` |

> Note the account-name regex is tested against the **joined** account names
> (`vals.join(" ")` in the engine, `array_to_string(...)` in SQL), whereas the
> `4020` prefix is tested **per element** — matching how the engine evaluates
> `regex` vs `prefix` modes. The classifier mirrors both.

The fidelity test (`quickbooks-rules-fidelity.test.ts`) asserts
`evaluateRules(SEED_RULES)` === `classifyStagedPayment` over a fixture set, so the
TS classifier and the seed rule can't silently drift.

The account-name / memo match works on the historical back-catalog without a full
re-pull — those fields are captured on every staged row.

### Verify

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

SELECT conditions FROM quickbooks_handling_rules WHERE id = 'seed_earned_income';
```

`earned_income` excluded count should rise by the number of bare-account-name
rows; `pending` should drop by the same amount; the rule's `conditions` should
list **four** entries (4020 prefix + memo regex + line-description regex +
account-name regex).
