# Runbook — 0076 CMO Replication / CSP grant reconciliation

## What this does

Cleans up the U.S. Department of Education **"CMO Replication / CSP"** grant in
PRODUCTION so it is represented as **one $12.7M grant pledge** with one CRM
payment per QuickBooks CSP deposit, and so all 61 of those deposits leave the
Finance Reconciliation review queue. It is **data only** (no schema change, no app
code) and is delivered as one idempotent SQL file applied by a human:

```bash
# dev (note: dev has NO CSP staged rows — see "dev vs prod" below)
psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0076_cmo_csp_grant_reconciliation.sql
```

```bash
# prod
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0076_cmo_csp_grant_reconciliation.sql
```

`psql -1` wraps the whole file in ONE transaction; the file has **no** top-level
`BEGIN/COMMIT`.

## Anchors (verified against PRODUCTION)

| Thing | Id |
| --- | --- |
| Donor org — U.S. Department of Education (`issues_grants = true`) | `recHG2Cva8hJRzB6Y` |
| Core pledge — becomes the single $12.7M grant pledge | `recX8CNJdnAq66sdR` |
| Duplicate $1M pledge — **archived** | `recZ4qDrnKGhOyrq2` |
| Its 3 "national funds" gifts — **archived** | `recQxIzArMnFEdgVS` ($187k FY24), `recgONhEnsP3p8B59` ($200k FY25), `recuk5liHKVem9aOh` ($200k FY26) |
| Entity (all allocations) | `wildflower_foundation` |
| Charter allocation project | `charter_growth` |
| Owner / confirmer / approver stamped on minted rows | `usr_matthew_kramer` (admin) |

## What each section changes

| Section | Change | Net effect |
| --- | --- | --- |
| A | Delete the synthetic $9.6M pledge allocation; upsert the **10 real** allocations ($12.7M total) | pledge scope = 10 rows, $12.7M |
| B | Archive the duplicate $1M pledge + its 3 national-funds gifts | separate money removed from totals (archived, **not** converted) |
| C | For each of the **61** pending non-zero `payer_name='CSP'` deposits: mint 1 gift + 2 split allocations + 1 QB cash-application ledger row | +61 gifts, +122 gift allocations, +61 payment_applications |
| D | Resolve those 61 staged payments to the reconciler's `create_gift` terminal state | 61 rows leave the review queue |
| E | Repurpose the core pledge header to the single $12.7M grant pledge | header = $12.7M, derived `paid` ≈ $4.91M |

## The 10 core-pledge allocations (section A)

All `entity_id = wildflower_foundation`. Charter rows are
`intended_usage='project'`, `fundable_project_id='charter_growth'`,
`formally_restricted=true`, `reimbursable_share='direct'` (so they are **excluded
from goal analytics**, like every direct-tagged line). Gen-ops rows are
`intended_usage='gen_ops'`, `reimbursable_share='indirect'` (they **count** toward
goal).

| FY | Charter (direct) | Gen Ops (indirect) |
| --- | --- | --- |
| FY2024 | $2,286,000 | $254,000 |
| FY2025 | $2,286,000 | $254,000 |
| FY2026 | $2,159,000 | $381,000 |
| FY2027 | $2,159,000 | $381,000 |
| FY2028 | $2,159,000 | $381,000 |
| **Total** | **$11,049,000** | **$1,651,000** |

Grand total **$12,700,000**.

## The per-deposit split (section C)

Each CSP deposit becomes one gift (donor = U.S. Dept of Education,
`type='pledge_payment'`, `final_amount_source='quickbooks'` pointing back at the
staged row, `counts_toward_goal=true` at the header — the goal split is enforced at
the **allocation** level). Its two allocations split by deposit fiscal year:

- **FY2024 / FY2025:** 10% gen ops (indirect) + 90% charter (direct).
- **FY2026:** 15% gen ops (indirect) + 85% charter (direct).

The gen-ops line is `ROUND(amount * pct, 2)`; the charter line takes the
**remainder** so the two always sum to the gift amount exactly. Each gift also gets
one `payment_applications` ledger row (`evidence_source='quickbooks'`,
`match_method='human'`, `created_the_gift=true`) so it derives
`quickbooks_tie_status='tied'` (the file sets `'tied'` on the header to match).

> **Do NOT set `gift_allocations.display_usage`** — it is populated by a DB trigger
> ("Charter Growth" / "Gen Ops"). The file omits it; verified trigger-populated in dev.

### Deposit fiscal-year distribution (the working set, 61 rows, $4,909,525.65)

| FY | Rows | Total |
| --- | --- | --- |
| FY2024 | 15 | $810,274.43 |
| FY2025 | 19 | $1,845,426.97 |
| FY2026 | 27 | $2,253,824.25 |
| **All** | **61** | **$4,909,525.65** |

The working set is selected live as
`payer_name='CSP' AND status='pending' AND amount IS NOT NULL AND amount <> 0`, so
the file always operates on exactly the rows still in the queue. A top-of-file guard
**RAISES and aborts** if any in-scope CSP deposit falls outside FY2024–FY2026 (the
split rule is undefined there). Verified: **none** currently do.

### The 61 staged-payment ids (for audit)

```
FY2024 (15): 81whqzPvgp7WP_BIYNTNG CCiYD4RYV-sv2sNEAf4m8 DqUmp6AVIBspVpguQLWyB
  EOICyRhWv8gMCkWe8iFPi L5URHWp50jJGdqRrJ6f0f NZUaTQC16nOJWTyFjG5LO
  OKsMlEsoFMNqO_1RpaUxl VoZ5L6yXjdw7CKI931cD_ wFVO0IonkbtU9nQSmEFLV
  C_2i7NqGwoBTAnc0wQfOn EBA0tllBgxsg8uob7d2wz P00l-73BbybvrS4FP4HsS
  gatsqoyHnZT_JFkdMKwQo ikb4HCYUYfWEsTW0j9Nyb r1rAZt0EYgCS89Imme7Gm
FY2025 (19): zVUbAl1_tNP17uHg7syzL 6Idk3HWaJWuZU0HZdulNk XFLKF82PBX1pIAV1SleAm
  zuA5fwhoyj8Vlt9j9-c7G IqK33ws2upkhGu3GKQld8 Wqy-YUL9-9c4hPxvX0do1
  UV-H_5mFOxk9x_fisaX-v rvuP94U3_cwsKZGQ5YXYV aDVfyRep5VM6XMGu-6sEe
  IPdbW_Ct7zw_32CVZqpjS MyHZkH0dOW2mLAOZ4yBzT 7ZhnSvshBfUpkvYA6gg3W
  M3vNk_xdNgN3Ut_q9kyy6 L9We0jG9T4JGrodyzCboz ZujzIaNrAykMCIqybfgGt
  1j9tsOb5RDCcZ8cPu8Chr DPfAFjulUPT5B0f3ngSTi NbeusM49NwHdDgZkARDun
  3q7zH4VLQ0bZCV70yoMTY
FY2026 (27): CDIJFjWfndjENrLjbNK5Z VnP-3NQCOqSLQoaEMp454 eNQxQ3tm5SRWHJADsbK0O
  zl6dgU1RKoTwbIRHFyru5 mQn0q4yHYHy4vmoLh-opQ trXDwBRNM9hyBZfFl0-ao
  5Y1_RQ7tyyb1XLaxSrEBx KiG3oQn7K9OoY75Vgh3Gk YQ5BvmyQbZGsvozTMHTaM
  UQEuXXTcr4JBh9xo7BxKO eRda7lfosGWxA3CbV2LX4 IHH82ntNzoplvAYKkJnQO
  RnXPFMN36gDQ52D631RMW hgztME5XGAxk-A0_ehoX7 mX_QwYzSnjiuiKEx81KRP
  2q_E8X9AyUeJAXcg2hE5D n05VjKs3yE-cY40mItQs- dzyXZQGgQd2sHDKUCRhGl
  lcB1Kuppcsg0UhLtuJnNg cLNQ2CzfDVh5uTBOClYio W3FRhvHCc1UQ0ANLQ1Epf
  iApQ2VpSo-uMiFBT9q4Te _3nebfQ8NtS37AUHkoaKz u8lShRnmV5lpoRK4eMj3v
  lJyS6Y5znQl3ePESuzUBF VvVCxZL2lIiFpjuVtK238 3dPCJKMWa7hNJiDbzofGv
```

## Items to flag (verified — do NOT silently auto-handle)

1. **Bulk back-dated FY2024 clusters.** 9 deposits are dated **2024-04-04** and 6
   are dated **2024-04-17** — these look like bulk QuickBooks catch-up entries, not
   15 individual wires. They are booked to FY2024 by date as-is. (The original spec
   said "15 rows dated 2024-04-04"; the live data is 9 + 6 across the two dates — all
   15 land in FY2024 either way.) If the team wants them on the true wire dates,
   re-date in the app afterward.
2. **Receivable-coded deposit `zVUbAl1_tNP17uHg7syzL`** ($124,613.68, dated
   **2024-07-01**) is coded `1503 Pledges/Services Receivable` (not the usual
   `Unrestricted Donations -Governmental`). Dated 2024-07-01 it lands in **FY2025**
   and gets the FY2025 10% / 90% split like any other FY2025 deposit. Confirm that FY
   attribution is what Finance wants for the receivable.

## Derived state (mirrors `deriveOppFields`, set explicitly in section E)

The core pledge header is set to: `ask_amount = awarded_amount = 12,700,000`,
`loan_or_grant='grant'`, `written_pledge=true`, `actual_completion_date=2023-03-31`.
Because `written_pledge=true` and `paid` (~$4.91M) `< awarded` ($12.7M):
`status='pledge'`, and a won row reads `stage='complete'`; non-conditional ⇒
`win_probability=0.9000`. `paid` is set from the live rollup
`SUM(linked non-archived gift.amount)` (section E runs after section C), so it equals
the sum of the 61 minted gifts = **$4,909,525.65**. `fundraising_category` stays
`revenue` (CSP is grant money).

## Terminal staged-payment state (section D)

Mirrors the reconciler's **`create_gift`** path (verified against
`routes/reconciliation/approve.ts`), **not** the spec's earlier `'approved'` hint:
`status='reconciled'`, `created_gift_id` set, `matched_gift_id=NULL`,
`auto_applied=false`, `match_status='matched'`, `match_confirmed_by_user_id` +
`match_confirmed_at`, `approved_by_user_id` + `approved_at`. Guarded on
`status='pending'` **and** the gift existing, so an already-resolved row is never
clobbered.

## dev vs prod (important)

The 61 CSP staged rows live in **prod only** — the dev DB has no CSP staged
payments (QuickBooks data is prod-only). Section C is therefore a clean no-op on dev
(empty working set), while sections A, B, E run identically in both. The file was
validated on dev by **seeding 3 representative CSP staged rows** (one per FY,
including a rounding edge case): the migration applied cleanly, each gift's two
allocations summed exactly to its amount, `display_usage` was trigger-populated, the
ledger rows produced `quickbooks_tie_status='tied'`, the staged rows reached the
terminal state above, and the pledge derived to `paid` = sum / `status='pledge'` /
`stage='complete'` / `win_probability=0.9000`. The seed was then fully removed and
dev restored to baseline.

## Ordering

**Run AFTER Publish.** Every column, enum value, entity slug
(`wildflower_foundation`), project (`charter_growth`), and `fiscal_years` id used
here already exists in prod (all verified read-only). The `payment_applications`
table exists in prod.

## Idempotency

Safe to re-run. After a successful apply, the working set
(`status='pending'`) is empty, so section C inserts 0 and section D updates 0; the
gift/allocation/ledger INSERTs are `ON CONFLICT DO NOTHING` on deterministic ids
(`csp-gift-<spid>`, `csp-ga-<spid>-genops|-charter`, `csp-pa-<spid>`); the archives
are guarded `archived_at IS NULL`; the section-A allocation upsert and the section-E
header UPDATE write **absolute** values (a re-run only bumps `updated_at`). Verified
on dev: a second apply changed no data values.

## Verify (by STATE, not clean exit) — run against prod after applying

```sql
-- Core pledge header: $12.7M / paid ≈ $4,909,525.65 / pledge / complete / 0.9000
SELECT ask_amount, awarded_amount, paid, status, stage, written_pledge,
       win_probability, actual_completion_date
  FROM opportunities_and_pledges WHERE id = 'recX8CNJdnAq66sdR';

-- Pledge allocations: 10 rows, $12.7M total, $11.049M charter (direct) / $1.651M gen ops (indirect)
SELECT count(*) n, sum(sub_amount) total,
       sum(sub_amount) FILTER (WHERE reimbursable_share='direct')   charter,
       sum(sub_amount) FILTER (WHERE reimbursable_share='indirect') genops
  FROM pledge_allocations WHERE pledge_or_opportunity_id = 'recX8CNJdnAq66sdR';
-- synthetic allocation must be gone:
SELECT count(*) synth_remaining FROM pledge_allocations
 WHERE id = 'synth-pa-recX8CNJdnAq66sdR-wildflower_foundation-fy2024';  -- 0

-- Archives: all four archived
SELECT id, (archived_at IS NOT NULL) archived FROM opportunities_and_pledges WHERE id = 'recZ4qDrnKGhOyrq2'
UNION ALL
SELECT id, (archived_at IS NOT NULL) FROM gifts_and_payments
 WHERE id IN ('recQxIzArMnFEdgVS','recgONhEnsP3p8B59','recuk5liHKVem9aOh');

-- 61 minted gifts, all tied to the pledge, all quickbooks_tie='tied'
SELECT count(*) n, sum(amount) total,
       count(*) FILTER (WHERE quickbooks_tie_status='tied') tied
  FROM gifts_and_payments WHERE id LIKE 'csp-gift-%';  -- 61 / 4909525.65 / 61

-- Every minted gift's two allocations sum exactly to the gift amount (0 mismatches)
SELECT count(*) mismatches FROM (
  SELECT g.id FROM gifts_and_payments g JOIN gift_allocations ga ON ga.gift_id = g.id
   WHERE g.id LIKE 'csp-gift-%'
   GROUP BY g.id, g.amount HAVING sum(ga.sub_amount) <> g.amount
) x;  -- 0

-- 61 cash-application ledger rows, all minted by this file
SELECT count(*) n, count(*) FILTER (WHERE created_the_gift) minted
  FROM payment_applications WHERE id LIKE 'csp-pa-%';  -- 61 / 61

-- All 61 staged rows left the queue at the create_gift terminal state
SELECT status, count(*) FROM staged_payments
 WHERE payer_name='CSP' AND amount IS NOT NULL AND amount <> 0
 GROUP BY status;  -- reconciled: 61 (0 pending)
```

## Deferred / NOT done in this file

- **Re-dating the bulk FY2024 clusters** (2024-04-04 ×9, 2024-04-17 ×6) to true
  wire dates — left as-booked; re-date in the app if Finance wants the real dates.
- **Receivable-coded deposit FY attribution** (`zVUbAl1_tNP17uHg7syzL`) — booked to
  FY2025 by date; confirm with Finance.
- **Revenue-accounting coding** (`object_code`, `revenue_*`, `restriction_type`
  refinement) on the minted allocations — left at insert defaults; code in-app if
  desired.
