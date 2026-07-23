---
status: ratified
last_verified: 2026-07-23
---

# ADR: Bank-anchored money model — bank deposit is the spine, QBO is downstream

**Status:** Ratified 2026-07-23 (owner design discussion; supersedes
[`adr-linear-money-model.md`](adr-linear-money-model.md) §3, the Layer-2
bank-anchored target). Implementation under way as a sequence of prod-safe,
additive-first phases (§6). Written in response to the owner's
"bank-deposit-as-spine" design note (2026-07-23).

**Relationship to existing docs.** This is the **successor to
[`adr-linear-money-model.md`](adr-linear-money-model.md) §3 (Layer 2, the
bank-anchored linear tree)**, which is already ratified as the *direction* but
still `design-target` and unstarted. That ADR keeps the bank statement as the
conceptual root while QuickBooks rows (`staged_payments`) remain the physical
anchor for non-Stripe money. This proposal takes the last step Layer 2 implied
but never committed to: make the real-world money objects **first-class tables**
(`bank_deposits`, `payment_units`, `bank_deposit_components`) and demote QBO to a
downstream accounting mirror + check-inference source. If ratified, this ADR
supersedes §3 of the linear-money ADR and the `settlement_links` /
`stagedPaymentSplitUnits` mechanisms described below; Layers 1–2 coding rules
(gift = one payment event; meaning splits on allocations; expectations on the
pledge) carry over unchanged.

---

## 1. The one-sentence thesis (owner's)

> Actual bank deposits and donor-level payments are the spine. QBO is a
> downstream accounting record and a temporary inference source, not the arbiter
> of the money model.

Everything below is how that lands on the current schema and code.

## 2. What already exists and is reused (do not rebuild)

The current codebase is much closer to this target than the note assumes.
Reuse, don't reinvent:

| Target concept in the note | Already in the repo | Gap to close |
| --- | --- | --- |
| `bank_deposits` (the spine) | `bank_transactions` (migration 0156) already ingests every bank-register line, source-tagged `qbo_register_export` now / `plaid` later, read-only, no FKs | `bank_deposits` is a **curated projection of the deposit-type `bank_transactions` rows** (a real deposit gets a stable id + becomes an anchor), not a new source. Add the table + the projection/dedup rule. |
| `payment_units` (donor-level payment) | Nothing. Stripe charges live in `stripe_staged_charges`; checks are `staged_payments` rows / split children; Donorbox in `donorbox_donations` | New canonical table. Backfill 1:1 from the existing source rows. |
| `bank_deposit_components` (checks in a deposit) | `staged_payments.split_parent_id` + `stagedPaymentSplitUnits.ts` implement deposit composition **inside the QBO table** today | This is exactly the "physically move it out of the QBO table" the note calls for. New table; migrate split children into it. |
| `payment_gift_applications` (unit → gift) | `payment_applications` is **already** the source-polymorphic unit→gift ledger, with counted-uniqueness (three per-anchor partial unique indexes) and `amount_applied` | Collapse the three anchors (`payment_id` / `stripe_charge_id` / `donorbox_donation_id`) to one `payment_unit_id`. This is a large simplification, not a new table. |
| `stripe_payouts.bankDepositId` + `ambiguousBankMatch` | `settlement_links` (payout ↔ QB deposit lump) with `lifecycle` (`proposed`/`confirmed`/`exempt`) + `provenance` | Move the pointer onto `stripe_payouts`, drop the lifecycle/confirmation workflow, replace with a recomputed deterministic match + ambiguity flag. |
| Determinative source links (charge↔payout, charge↔donorbox) | `source_links` (migration 0149) is the sole evidence↔evidence claim ledger with `lifecycle` + `provenance` | The note reclassifies most of these as **recomputed facts, no proposed→confirmed**. Keep the table for the genuinely ambiguous residue; drop lifecycle for ID-determinative links. |
| QBO discrepancy sidecar | The revenue-coding snapshot columns already on `staged_payments` (`object_code`, `revenue_location`, `revenue_class`, `deferred_revenue`, `coding_flags`) + `giftQbTie.ts` derivation | Repurpose as the "expected posting vs actual QBO" comparison, read-only accounting review. |

**Net:** four of the note's building blocks already exist in some form. The work
is (a) add `bank_deposits` / `payment_units` / `bank_deposit_components`, (b)
re-anchor the existing ledgers onto `payment_units` and `bank_deposits`, and (c)
delete the machinery that only existed to arbitrate between competing
representations.

## 3. Target physical model (mapped to current tables)

```
RAW SOURCES (sync-owned mirrors, never edited to express a relationship — INV-G)
  bank_transactions          (exists; register/Plaid lines)
  stripe_payouts             (exists)
  stripe_staged_charges      (exists)
  donorbox_donations         (exists)
  qbo_payment_records        (== staged_payments, renamed LAST)

REAL MONEY (new canonical layer)
  bank_deposits              NEW — curated deposit rows (projection of bank_transactions)
    └── bank_deposit_components   NEW — checks/direct payments composing a deposit
          └── payment_unit_id
  payment_units              NEW — one donor-level payment (stripe_charge|check|ach|wire|other)
    stripe_charge_id  UNIQUE nullable
    donorbox_donation_id UNIQUE nullable
  stripe_payouts.bank_deposit_id  NEW column + ambiguous_bank_match flag

FUNDRAISING
  payment_gift_applications  (== payment_applications, re-anchored to payment_unit_id)
  gifts_and_payments / gift_allocations   (exist, unchanged)
  opportunities_and_pledges / pledge_*    (exist, unchanged)

ACCOUNTING (sidecar — review only, never a money ledger)
  expected QBO posting (derived) vs qbo_payment_records (actual) → discrepancy/disposition
```

Structural rules preserved from the note:
- Stripe charges compose a **payout**, the payout composes a **bank deposit** —
  they are NOT `bank_deposit_components`. Only checks/direct payments are
  components.
- One parent per node; splits happen only by subdividing a node; meaning splits
  only on `gift_allocations` (unchanged Layer-1 rule).

## 4. Where I agree, with engineering caveats

1. **Unified `payment_units`.** Agree, and it is a real reduction: today
   book-once/counted-uniqueness needs **three** per-anchor partial unique indexes
   on `payment_applications` (`_payment_id_counted_uq`,
   `_stripe_charge_id_counted_uq`, `_donorbox_donation_id_counted_uq`) plus three
   `evidence_source` CHECKs. A single `payment_unit_id` anchor collapses these to
   one `UNIQUE(payment_unit_id) WHERE link_role='counted'`. This directly serves
   replit.md invariant #10 ("reduction is the success criterion").

2. **Bank-deposit-as-counted-anchor is a genuine anchor migration.** Today the
   Stripe charge is the counted anchor and stays so; non-Stripe money is anchored
   on the QB row. Moving the counted anchor to `payment_units` for ALL sources is
   correct but must go through the repo's mandatory discipline (replit.md /
   reconciliation-design INV-F): additive → dual-write → backfill → **prod
   parity** → flip reads → deprecate → drop, human-applied SQL. It cannot be a
   single cutover.

3. **Donorbox `UNIQUE(payment_units.donorbox_donation_id)`, one direction.**
   Agree. Keep the sync-derived `donorbox_donations.stripe_charge_id` enrichment
   join as imported evidence (it already is); the authority becomes the
   payment-unit pointer. Do not add a reciprocal pointer.

4. **Determinative links need no lifecycle.** Agree. `source_links` today models
   charge↔qb, charge↔fee-row, donorbox↔qb, donorbox↔charge with a
   `proposed/confirmed` lifecycle. For links stated by source IDs (charge→payout
   from Stripe, charge↔donorbox by `ch_…`), drop the lifecycle and recompute
   idempotently on sync. Keep `source_links` (or a slimmer successor) only for
   the residue that is genuinely a human judgment. The **judgment surface then
   reduces to exactly three things**: (a) breaking a deposit into check
   components, (b) tying the determinative Stripe/bank chain to the flaky QBO
   records (`charge_qb_tie`, and the QBO-corroboration comparison), and (c) the
   rare ambiguous payout↔deposit match — handled by a flag, not a workflow.

5. **Pointer direction: payment_unit → donorbox, one authority.** Agree with the
   owner's flip. Both a Stripe-charge unit and a check-component unit carry the
   same `donorbox_donation_id` pointer — populated by sync for charges (Donorbox
   reports `ch_…`; the pulled `donorbox_donations.stripe_charge_id` stays as
   ingest evidence feeding the writer) and by judgment for checks entered as
   Donorbox offline donations. `UNIQUE(payment_units.donorbox_donation_id)` gives
   "one payment per donation" in a single index, and the `donorbox_qb` /
   `donorbox_charge` source-link overlay retires. Keep `payment_units`
   **parent-free**: a check's parent is `bank_deposit_components`, a charge's
   parent is its payout — do NOT add a polymorphic parent pointer on
   `payment_units` (that would re-introduce exactly the pointer shape 0149
   removed).

6. **Payout→bank-deposit is a recomputed match + `ambiguous_bank_match`, not a
   workflow.** Agree. Replace `settlement_links` lifecycle with
   `stripe_payouts.bank_deposit_id` + `ambiguous_bank_match boolean` +
   `bank_matched_at`, `UNIQUE(bank_deposit_id)`. Deterministic pairing on
   amount/currency/account/arrival-date; flag equal-amount same-day collisions,
   build no confirm UI. Note the existing `settlement_links_deposit_required_chk`
   / `ON DELETE SET NULL` latency documented in reconciliation-design §4.3 goes
   away with the table.

## 5. Interim reality vs destination (the one place "QBO = corroboration only" overstates)

The destination is "QBO is a downstream mirror + temporary split-inference
source." But be honest about the **interim**: today QBO (`staged_payments`) is
also the *sole source of donor identity* for check money — `payerName`,
`qbCheckNumber`, the memo, and the whole donor-match scorer run off it, and the
donor FKs (`organizationId` / `individualGiverPersonId` / `householdId`) live on
that row. Until Plaid/check-images arrive, a check's **donor attribution has no
other source**. So in the interim QBO supplies three things, not one: deposit
composition (→ components), donor identity for checks (→ the check
`payment_unit`), and accounting coding (→ the corroboration sidecar). The
"minimal / corroboration-only" framing is the *destination*; the migration must
carry donor identity forward onto the check `payment_unit`, not leave it stranded
on a demoted QBO row.

**Two QBO views of one deposit — do not conflate them.** QBO gives us the deposit
twice: (i) the **bank-register line** (already ingested as `bank_transactions`,
`source='qbo_register_export'` — the asset-account side, closest to the real
bank) and (ii) the **QBO Deposit transaction's lines** (`staged_payments` deposit
lines / split children — the GL side). The **spine (`bank_deposits`) projects
from (i)**; the **check composition comes from (ii)**. They are QBO's mirror of
the bank feed *and* QBO's GL, respectively — seeding `bank_transactions` "from
QBO deposit rows" is already what 0156 does via the register export, so there is
no extra seeding step, just the projection rule.

**Donorbox-offline-check dedup risk.** A check that is *also* recorded in Donorbox
as an offline donation is one real payment. Today the Donorbox new-money worklist
can mint its own gift while the QBO deposit line also stages the same check —
two representations of one payment. Under the new model both must resolve to a
**single check `payment_unit`** carrying the `donorbox_donation_id`; the backfill
and the forward writer need an explicit dedup so the deposit-sourced check unit
and the Donorbox-sourced one do not both count.

## 6. Where to be careful / disagreements of sequencing

- **Finish 0158 first — it is not wasted.** The counted-uniqueness work the
  building agent is landing (three per-anchor partial unique indexes) is correct
  for *today's* shape and should ship. `payment_units` re-anchoring later
  *replaces* those three with one `UNIQUE(payment_unit_id)` — supersession, not
  waste. Do not block or skip 0158 on account of this ADR.
- **Do not start before the in-flight linear-money rollout lands.**
  `adr-linear-money-model.md` §7 is mid-flight: multi-match done, unit_groups
  retired, prod recoding `0157` applied, **counted-uniqueness `0158` still
  awaiting human apply**, Layer 2 unstarted. Re-anchoring
  `payment_applications` onto `payment_unit_id` touches the exact indexes `0158`
  adds. Starting `payment_units` before `0158` is applied in prod means two
  migrations racing on the same table. **Sequence this ADR strictly after `0158`
  is applied and verified.**

- **History is frozen; this is forward-only.** Layer 2 already commits to an
  explicit cutover seam ("history is never recoded to the new direction"). The
  bank spine applies to money **after** the cutover; the historical matched lens
  (Stripe payout ↔ QB deposit) stays frozen and must not be re-pointed at
  `bank_deposits`. Keep the two lenses in separate queues (they already are).

- **`bank_deposits` identity is the hard part.** `bank_transactions` are
  overlapping register exports deduped by a synthetic `dedup_key` + `occurrence`,
  with **no FKs and no deposit grouping**. Promoting a deposit line to a
  `bank_deposit` needs a stable id and a documented projection rule (which
  register rows are "a deposit", how re-imports stay idempotent). Until Plaid,
  the spine is only as reliable as the register export.

- **Provisional check components must be replaceable.** Per the note, QBO-inferred
  components carry `source='qbo_inferred'` and `needs_review`; when
  check-register/Plaid/bank-image data arrives, update `source` + facts in place,
  never redesign the relationship. The migration from `staged_payments`
  split-children → `bank_deposit_components` + provisional `payment_units` must
  preserve `split_parent_id` sums exactly (the split invariant: children sum to
  parent).

- **Contract-first, every step.** Every new table/column is an OpenAPI change
  first (`lib/api-spec/openapi.yaml`), regenerate (`pnpm --filter
  @workspace/api-spec run codegen`), then implement. New derivations belong in
  the existing single-authority derivers (`derivedStatus.ts`, `giftQbTie.ts`,
  `reconciliationLanes.ts`) — not new stored status columns (invariant #3).

- **QBO stays pull-only.** The discrepancy sidecar computes an *expected* posting
  and compares; it never writes QuickBooks and never becomes a second money
  ledger (invariant on §5 of linear-money ADR; replit.md audit_ready rule).

## 6. Implementation order (the note's 13 steps, re-expressed as prod-safe phases)

Each phase is independently shippable and reversible; every prod **data** change
is a reviewed, idempotent, human-applied SQL file in `lib/db/migrations/`
(INV-F). Phases 0 is a precondition; 1–4 are additive+backfill; 5–7 flip reads;
8–9 retire.

0. **Precondition:** `0158_counted_uniqueness_index.sql` applied + verified in
   prod. Write this ADR; freeze feature work on `settlement_links` /
   `stagedPaymentSplitUnits` / the `source_links` lifecycle. *(note steps 1)*

1. **Additive: `bank_deposits`** as a curated projection over `bank_transactions`
   (deposit-type rows), with a documented idempotent projection rule. No reads
   yet. Contract + schema + migration. *(note step 2)*

2. **Additive: `payment_units`** (kind, `stripe_charge_id` UNIQUE nullable,
   `donorbox_donation_id` UNIQUE nullable, gross/fee/net, received date,
   lifecycle). Backfill **one payment_unit per `stripe_staged_charges` row**,
   plus one per non-Stripe `donorbox_donations` row and per non-split
   `staged_payments` check/wire row. *(note steps 3, 5)*

3. **Additive: `bank_deposit_components`** (`bank_deposit_id`, `payment_unit_id`,
   `amount`, `source`, `source_qbo_payment_record_id`, `needs_review`). Backfill
   from `staged_payments.split_parent_id` children (each becomes a provisional
   `payment_unit` + a `qbo_inferred` component), preserving the children-sum-parent
   invariant. *(note steps 4, 6)*

4. **Additive: `stripe_payouts.bank_deposit_id` + `ambiguous_bank_match` +
   `bank_matched_at`;** recompute the deterministic payout→deposit match into
   them alongside (dual-write with) `settlement_links`. *(note step 8)*

5. **Re-anchor the ledger:** add `payment_applications.payment_unit_id`,
   dual-write it beside the three source anchors, backfill, prove prod parity,
   then flip every reader (`giftQbTie.ts`, `derivedStatus.ts`,
   `reconciliationLanes.ts`, `reconciliation/cards.ts`, `quickbooks/*`,
   `giftsAndPayments.ts`) to `payment_unit_id`. Collapse the three counted
   uniques to one. *(note step 7)*

6. **Donorbox authority** flips to `payment_units.donorbox_donation_id`; retire
   the `donorbox_qb` / `donorbox_charge` proposed/confirmed workflow where the
   link is ID-determinative. *(note step 9)*

7. **QBO → accounting role:** repurpose the coding-snapshot columns into the
   expected-posting vs actual comparison + disposition
   (`consistent|correction_needed|corrected|accepted_historical`). *(note step 10)*

8. **Parity verification:** totals and exact relationship parity old-vs-new,
   per-phase, in dev then prod read-only preflight. *(note step 11)*

9. **Retire** (human-gated drops, after clean parity): `settlement_links`,
   `staged_payments` split columns/service, the source-link lifecycle,
   proposed/confirmed on determinative links, the polymorphic anchors on the
   ledger. **Rename `staged_payments` → `qbo_payment_records` LAST.** *(note steps
   12, 13)*

## 7. What this retires (net reduction)

- The three per-anchor counted-unique indexes + `evidence_source` CHECKs on the
  ledger → one `payment_unit_id` unique.
- `settlement_links` (table + lifecycle + `conflictGiftId` + the
  deposit-required CHECK latency) → two columns on `stripe_payouts`.
- `staged_payments.split_parent_id` + `stagedPaymentSplitUnits.ts` → `bank_deposit_components`.
- `source_links` `proposed/confirmed` lifecycle for ID-determinative links →
  recomputed facts.
- The charge-tie supersede string/enum machinery (`chargeTieSupersede.ts`) and
  the coarse-deposit-gift supersede rule — subsumed because per-unit counting on
  `payment_units` no longer competes with a deposit-grain gift.
- QBO-to-gift counted links for Stripe money; counted-vs-corroborating roles for
  cross-processor duplicates.

## 8. Open questions for the owner

1. Accountant grain for the QBO expected-posting comparison (one entry per
   allocation vs rolled up) — still the open assumption from linear-money ADR §3.
2. `bank_deposits` projection rule before Plaid: is the QBO register export
   trustworthy enough to be the spine, or do we gate the forward cutover on Plaid?
3. Scope of forward cutover: all entities at once, or one Wildflower entity first?
