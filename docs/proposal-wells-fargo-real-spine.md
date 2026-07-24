# Proposal: real bank deposits (Wells Fargo) as the spine

Status: draft for discussion — no code yet.

## The problem this fixes

`bank_deposits` today is `source = 'qbo_register_export'` for all 2,245 rows —
it's the **QuickBooks banking register**, not the bank. QB over-splits: e.g.
Arthur Rock's $1.6M is **one** real Wells Fargo deposit but **three** QB rows.
So the ADR's premise ("actual bank deposits are the spine") isn't met. We
re-source the spine from the real WF exports.

## Source data (the 8 exports, merged)

- 1,344 unique bank transactions after dedupe; **1,028 money-in (deposits)**;
  2016-07-27 → 2026-07-21; ~$39.6M total in.
- Of the deposits: 226 "STRIPE TRANSFER" lines, 23 brokerage (stock) transfers.
- Two header variants normalized to one shape:
  `date, amount, description, from_to, qb_posting, donor?`
  (`donor` + `Match/Categorize` only present on the recent batch;
  `qb_posting` = the "Added to: Deposit: <QB account> <date> $x" bridge).

## Design

1. **Stable id / idempotency.** WF has no native transaction id, so
   `source_bank_transaction_id = hash(date, amount, normalized description
   [+ occurrence index])`. Only 6 (date, amount) pairs repeat, disambiguated by
   description/index. Re-import is idempotent — no dupes.

2. **New source.** Add `bank_deposit_source = 'wells_fargo'`. Ingest all 1,028
   money-in rows as `bank_deposits`.

3. **QB is demoted, not deleted.** The QB register lines stay in the system as
   `staged_payments` / QB accounting evidence (the downstream accounting
   record). The QB "Added to: Deposit: <account>" marker becomes the **bridge**
   from a real WF deposit to its QB booking/classification. We only remove QB as
   the *bank* spine.

4. **Cascade (the real work), all re-runnable:**
   - **Payout→deposit:** re-match the 226 WF STRIPE lines to `stripe_payouts`
     (deterministic amount + arrival window), replacing the 145 matches that
     currently key to QB-register deposits.
   - **Components:** recompute `bank_deposit_components` (217 today) — check /
     ACH / wire / brokerage payment units re-composed against real WF deposits.
   - **Accounting checks:** unchanged in shape; deposit linkage refreshed.

5. **Retire the 2,245 `qbo_register_export` rows** only after components and
   `stripe_payouts.bank_deposit_id` are re-pointed to WF deposits (they FK to
   bank_deposits today).

## Open questions (need your call)

1. **Ongoing feed.** Is WF a *periodic manual CSV upload*, or will there be an
   automated feed (Plaid / WF direct)? This decides whether the ingest is a
   script + admin upload, or a sync integration like Stripe/QBO.
2. **Where do the CSVs live for the prod ingest?** They're your downloads;
   for prod I'd either commit them to the repo (they carry donor names — mildly
   sensitive, not secret) or load them via an admin import path. Preference?
3. **QB bridge.** OK to use QB's "Added to: Deposit: <account>" posting to
   attach each real WF deposit to its QB accounting classification (so we keep
   the QB association without QB being the spine)?

## Not in this step

- The 5 parked gifts (reckbnr, rechsL1t, recjtiy, recs30m, recTUSU) — you're
  inspecting those.
- The deposit-first workbench build (comes after the real spine lands).
