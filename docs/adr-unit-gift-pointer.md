# ADR: unit→gift pointer (retire payment_applications)

**Status:** ratified 2026-07 (owner decision). Successor of the
`payment_applications` ledger; schema landed in 0193–0194, physical
retirement gated in 0195.

## Decision

The tie stage of the spine chain (docs/adr-qbo-evidence-grain.md §1)

```
bank_deposit ← bundle ← payment_unit → gift → gift_allocations
```

is a **direct backward pointer**: `payment_units.gift_id`. The
`payment_applications` ledger retires.

Why a pointer, and why on the unit side:

- **One unit funds exactly one gift.** Pledges live in their own table and
  every installment is its own gift record, so unit→gift is genuinely 1:1
  from the unit's side. Prod confirms it: all 777 counted ledger rows have a
  unit that funds exactly one gift. (14 legacy gifts are funded by several
  units — pre-split installment shapes; they get split into per-installment
  gift records, not modeled around.)
- **`amount_applied` carried no dollar fact.** Every counted row's amount is
  the unit's own gross (729) or net (48 — fee-net bookings). There are no
  partial applications. Gross-vs-net booking is a fact about the **QBO
  accounting record**, not the unit→gift tie, so it lives on the accounting
  plane (expected-vs-actual sidecar / QBO ties), never on the pointer.
- **Corroborating rows are evidence claims**, so they move where every other
  evidence claim lives: `source_links`, type `unit_gift_corroboration`
  (unit + gift anchors, deterministic id `srcl_ugc_<unit>_<gift>`).

## Transition (mirrors the QBO-tie retirement)

1. **0193/0194 (additive):** enum value; `payment_units.gift_id`
   (FK RESTRICT) + `source_links.gift_id`; backfill pointer from counted
   rows and corroborating rows into `source_links`.
2. **Dual-derivation:** `payment_applications` stays the write authority;
   the bank-spine recompute (step 6) keeps the pointer converged with the
   counted ledger after every sync.
   **Status (2026-07-29):** superseded in practice — no production code path
   inserts, updates, or deletes `payment_applications` rows anymore (verified
   by grep across the api-server; only test utilities touch the table, for
   legacy-row cleanup). The pointer is already the de-facto write authority;
   the ledger persists read-only pending the step-4 parity check and drop.
3. **Read cutover:** flip every ledger reader (gift totals, tie status,
   book-once guards) onto the pointer + corroboration links.
   **Progress (2026-07-29):** the integration-test fixture layer is cutover —
   test seeds mint `payment_units` and set the pointer (no raw counted-ledger
   inserts), and test readers assert against the pointer, so the suite no
   longer depends on `payment_applications` rows existing at 0195.
4. **0195 (gated):** drop `payment_applications` — only after cutover +
   parity verification, by explicit human decision.

## Invariants

- The pointer is the ONLY counted unit→gift authority after cutover; no
  reintroduced ledger, no gift-side pointer (a gift may be funded by several
  units only as a legacy shape pending installment splits).
- Book-once becomes structural: one `gift_id` column ⇒ a unit cannot fund
  two gifts.
- Non-counting unit↔gift evidence is a `source_links` claim, never the
  pointer.
