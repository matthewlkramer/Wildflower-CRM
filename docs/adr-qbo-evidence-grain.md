---
status: ratified
last_verified: 2026-07-23
---

# ADR: QBO evidence at every grain — one chain for money, one ledger for QBO ties

**Status:** Ratified 2026-07-23 (owner design discussion). Delta on top of
[`adr-bank-spine-money-model.md`](adr-bank-spine-money-model.md) and
[`adr-source-link-ledger.md`](adr-source-link-ledger.md). Written in response
to the owner's restatement of the target model (2026-07-23):

> our model is deposits (sourced from the bank exports) linked to bundles of
> payment units (stripe payout or equiv non-stripe) linked to individual
> payment units which are tied to crm gift records and which are further
> divided into allocations — and then the allocation rows + all of the
> information they inherit from earlier in the process feed into
> allocation-level qb rows. for the short term, we have qb rows at all sorts
> of different levels. we need the info that's in those records to help us
> make upstream ties. that could be represented in source links.

## 1. The model

**Money spine — each stage points backward to the stage before it:**

```
bank_deposit  ←  bundle (stripe_payout | non-Stripe deposit composition)
              ←  payment_unit  ← (payment_applications) → gift → gift_allocations
                                                                  ↓ (derived, end state)
                                                          allocation-level QBO entries
```

**QBO ties — one ledger, any grain.** QBO evidence exists today at several
grains (register posting rows, QBO Deposit lines, QBO Payment rows). Every
tie from a QBO record to a spine node is a typed `source_links` row —
never a bespoke per-grain table, never a pointer column on an evidence table.
The direction of meaning is: the spine money **feeds/produces** the QBO
accounting entry; the QBO record is downstream evidence, useful short-term as
inference input for making upstream ties.

**Clues at many grains, dollars at one.** One QBO row may legitimately carry
`source_links` claims to several spine nodes (it tells us which deposit AND
which bundle). But in reconciliation arithmetic its amount is counted at
exactly one grain — the finest grain it is tied at; coarser links are
corroborating evidence, never addends.

**Two QBO evidence surfaces, complementary, both raw:**

- `staged_payments` — the QBO **API** pull at incoming-money-unit grain
  (Payment / SalesReceipt / Deposit **line**), carrying QB identity
  (`qb_entity_id`, `qb_line_id`, `qb_deposit_id`) and per-donor-line facts.
  The register cannot replace it: register Deposit rows are one posting per
  deposit with no donor-line breakdown and no QB ids.
- `bank_transactions` (`source='qbo_register_export'`) — the QBO **report**
  export at account-register posting grain, covering all txn types.

Both are demoted from authority to evidence: composition and ties are
expressed in the spine tables + `source_links`, and `staged_payments`' CRM
review/matching state migrates to the reconciliation workflow over time.

## 2. New `source_links` link types

| link_type | FK shape | Claim |
| --- | --- | --- |
| `qbo_register_deposit` | `bank_transaction_id` + `bank_deposit_id` | this register posting is the accounting record of that bank deposit (several register rows may tie to one deposit — the same-day/same-donor multi-row pattern) |
| `qbo_register_unit` | `bank_transaction_id` + `payment_unit_id` | this register posting is the accounting record of that donor-level payment unit |
| `qbo_line_deposit` | `qb_staged_payment_id` + `bank_deposit_id` | this QBO Deposit line decomposes that bank deposit (accounting evidence only — replaces `deposit_qbo_components`) |
| `payout_qb_settlement` | `qb_staged_payment_id` + `stripe_payout_id` | this QBO row is the booked lump for that Stripe payout (replaces `staged_payments.settled_stripe_payout_id`) |

A structured `match_basis` column records HOW a machine tie was made
(`same_day_unique_amount` … `three_day_unique_amount`,
`same_donor_multi_row_sum`, `deposit_header_exact/ambiguous`,
`settled_pairing`, `human`); `note` stays free human text. Ambiguous machine
candidates are written `lifecycle='proposed'`, never auto-confirmed.

## 3. What retires

| Retired | Replaced by |
| --- | --- |
| `bank_deposit_qbo_register` (bespoke deposit↔register table, residual-only scope) | `qbo_register_deposit` links; the residual-only gating is dropped — a register tie coexists with payouts/components |
| `deposit_qbo_components` (provisional QBO decomposition sidecar) | `qbo_line_deposit` links |
| `staged_payments.settled_stripe_payout_id` (pointer column) | `payout_qb_settlement` links |

Retirement follows the repo's standard discipline: additive schema →
backfill → dual-write → read cutover → human-gated drops
(migrations 0189–0192; 0192 must not be applied before the read cutover).

## 4. Matching rules (forward recompute)

1. Register↔deposit matching runs over ALL bank-csv deposits (no residual
   gating). Single-row: unique exact amount within ±3 days, unique on both
   sides; `match_basis` records the day-gap class.
2. **Same-day/same-donor multi-row:** when ≥2 positive register rows share a
   date and normalized payee and their SUM uniquely equals a deposit within
   ±3 days, each row gets a `qbo_register_deposit` link
   (`match_basis='same_donor_multi_row_sum'`). Presumption: same physical
   payment unit; unit-grain `qbo_register_unit` links are added when the
   corresponding payment units exist.
3. Deposit-level explanation is the **rollup** of the row-level links, not a
   separate authority.
