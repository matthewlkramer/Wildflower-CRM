# 0045 — QuickBooks earned-income-by-memo

## What & why

A fundraiser reported QuickBooks records whose **notes/memo** say they are
"service income" or "earned income" still sitting in the **QuickBooks Review**
queue. These are fees-for-service / program revenue, never gifts.

The existing `earned_income` exclusion rule matched **only** the QuickBooks
"Services - Earned Income" income **account** (code prefix `4020`). A deposit
whose only earned-income signal lives in the free-text **memo / note** (with no
4020 line) was never caught.

The classifier now also matches an `"earned income"` / `"service income"`
whole-word phrase on the memo (`raw_reference`) or line description, folded into
the **same** `earned_income` reason and the **same** donation-first guard. No new
enum value, no OpenAPI/UI change.

## Code (ships via Publish)

- `quickbooksExclusionRules.ts` — `EARNED_INCOME_MEMO_PATTERNS` + extended
  `isEarnedIncomeLine` (account code **OR** a memo / line-description phrase,
  each field tested **separately** to stay in exact lockstep with the engine and
  the SQL).
- `quickbooksRules.ts` — `SEED_RULES.seed_earned_income` gains `memo_reference` +
  `line_description` regex conditions (match_logic stays `any`, `donation_guard`
  stays on).
- Tests: `quickbooks-exclusion-rules.test.ts` (memo cases + `unearned income`
  negative) and `quickbooks-rules-fidelity.test.ts` (seed/classifier parity,
  incl. the split-across-fields negative).

> **Important:** the code change alone is **not enough** in production. New pulls
> are classified by the DB-backed `quickbooks_handling_rules` table, not the
> in-code `SEED_RULES`; the existing review queue is never auto-reclassified. Both
> need the SQL below. Publish ships the *code* but never runs this file.

## Migration (human-run on prod)

`0045_quickbooks_earned_income_memo_backfill.sql` has **two idempotent parts** in
one transaction:

- **Part A — ingest rule.** Updates the persisted `seed_earned_income` row in
  `quickbooks_handling_rules` to add the memo + line-description regex conditions,
  so **new** pulls auto-exclude. Mirrors `SEED_RULES.seed_earned_income` exactly.
- **Part B — backfill.** Re-runs the refined rule over the **existing** review
  queue, marking memo-only earned/service-income rows `status = 'excluded'`.

```bash
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0045_quickbooks_earned_income_memo_backfill.sql
```

### Safety

- **Part A** fires only when `seed_earned_income` still holds its **full
  original** seeded shape: the canonical single-`4020` condition **and**
  `action='exclude'`, `exclusion_reason='earned_income'`, `donation_guard=true`,
  `match_logic='any'`. If an admin has customised **any** of those (e.g. turned
  off the donation guard, or set `match_logic='all'`), Part A skips it — add the
  two conditions from the admin page instead. Re-running after the update is a
  no-op (nothing is overwritten).
- **Part B** touches only rows currently `status = 'pending'` **and**
  `classification_source = 'auto'` — approved / rejected / already-excluded rows
  and any row a fundraiser manually re-included (`classification_source =
  'manual'`) are never modified.
- **Donation-first guarded** — never excludes a deposit that also carries a real
  donation line (a 4000/4100 donation account or a "Donation" item).
- Word-anchored (`\m…\M`) so `"unearned income"` cannot match; the memo and line
  description are tested **separately** so a phrase split across the two fields is
  not a match.
- Idempotent — re-running is a no-op. Nothing is deleted.

### TS ⇄ engine ⇄ SQL lockstep

| classifier (TS)                              | seed rule (JSONB) / SQL backfill                |
| -------------------------------------------- | ----------------------------------------------- |
| `/\bearned income\b/i`, `/\bservice income\b/i` per-field over `rawReference`, `lineDescription` | `{"field":"memo_reference"\|"line_description","mode":"regex","value":"\\bearned income\\b\|\\bservice income\\b"}` / `~* '\m(earned\|service) income\M'` per column |
| `EARNED_INCOME_ACCOUNT_CODE_PREFIXES = ["4020"]` | `{"field":"line_account_name","mode":"prefix","value":"4020"}` / `LIKE '4020%'` |
| donation-first guard (4000/4100 account, "donation" item) | `donation_guard: true` / `NOT EXISTS … LIKE '4000%'/'4100%'`, `NOT EXISTS … LIKE '%donation%'` |

The fidelity test (`quickbooks-rules-fidelity.test.ts`) asserts
`evaluateRules(SEED_RULES)` === `classifyStagedPayment` over a fixture set, so the
TS classifier and the seed rule can't silently drift.

The memo match works on the historical back-catalog without a full re-pull
because `raw_reference` (the deposit-level memo) is captured on every staged row.
The `4020` account / `line_description` clauses additionally benefit from line
detail; rows missing it are simply not matched by those clauses (no error).

### Verify

```sql
SELECT status, exclusion_reason, count(*)
FROM staged_payments GROUP BY 1, 2 ORDER BY 1, 2;

SELECT conditions FROM quickbooks_handling_rules WHERE id = 'seed_earned_income';
```

`earned_income` excluded count should rise by the number of memo-only rows;
`pending` should drop by the same amount; the rule's `conditions` should list
three entries (4020 prefix + two regex).
