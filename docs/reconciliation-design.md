---
status: design-target
last_verified: 2026-07-21
---

# Reconciliation — Target-State Design (ratified)

**Status:** ratified design, now largely implemented. This document is the
committed target for the reconciliation subsystem. It locks the model, resolves
the open decisions, and defines the prod-safe phased path. Each phase below (2–7)
was its own human-gated task. **Implementation status: Phases 2–5 have shipped
(migrations 0086–0093); see the banner at the top of §7 for the authoritative
per-phase status — the inline "Progress" notes under each phase are historical and
now lag the code.**

> **Superseded in part (2026-07-23):**
> [`adr-linear-money-model.md`](adr-linear-money-model.md) supersedes this
> document's `unit_groups` grouping design (§4.6b, the §6 group rows). The
> "N counted ledger rows → one gift" shape this document targeted is live via
> `POST /quickbooks/staged-payments/multi-match`, with **no** group record:
> new group creation is retired (the group/group-reconcile endpoints are 410
> stubs), and the `unit_groups` structure itself — although built — is slated
> for retirement in ADR §7 step 3. Existing legacy groups keep
> approve/ungroup/eject until then. Where this document presents `unit_groups`
> as the durable end-state, the ADR wins.

**Audience:** written for an engineer, with a plain-English overview first so a
non-technical reader can follow the shape of the decision. Where it names a file
or function, that is a pointer to *today's* code, not a promise it will keep that
name.

---

## 1. The whole thing in one paragraph

Money reconciliation reduces to **two planes, one link ledger, and one report
shape**. Plane 1 (*settlement*) is batch-to-batch: each Stripe **payout** should
equal a QuickBooks **deposit**. Plane 2 (*donor credit*) is unit-to-gift: each
incoming **unit** of money — a Stripe **charge**, a non-Stripe QuickBooks
**payment** (check / ACH / wire), or a non-Stripe **Donorbox** donation
(PayPal / pay-by-check) — should correspond to one CRM **gift**. The two planes
connect: Plane 1 is exactly what lets a Stripe charge tie to QuickBooks *through*
its payout instead of needing a per-charge QB match. The CRM **gift is the single
source of truth** for donor credit; external rows are permanent *evidence*, never
themselves gifts, never archived to dedupe money (the existing D4 invariant). The
end-state models every link as a ledger row with an `amount_applied`, a
`proposed → confirmed` lifecycle, and provenance — and derives every status as a
**pure function over that ledger**, exactly like `deriveGiftQbTie` /
`deriveOppFields` do today.

"Simpler" here means **finish the consolidation already started and delete the
superseded layers**, then collapse the UI — not invent a new paradigm.

---

## 2. Why it feels convoluted today (current state)

Three generations of "this money links to that record" are all live at once:

1. **Direct pointer columns on evidence rows** —
   `staged_payments.matched_gift_id / created_gift_id / group_reconciled_gift_id`,
   `stripe_staged_charges.matched_gift_id / created_gift_id /
   linked_qb_staged_payment_id`, the `staged_payment_splits` table,
   `gifts_and_payments.final_amount_qb_staged_payment_id`.
2. **`payment_applications`** — the "authoritative" M:N cash-application ledger
   meant to *replace* #1. QB-only today.
3. **`gift_evidence_links`** — a *second* M:N "corroborating, never counted" link
   table, used only by financial corrections (polymorphic, no FKs).

The **QB plane-2 (unit↔gift) cutover is DONE**: `payment_applications` is the
SOLE link record for QB staged payments ↔ gifts. The four legacy pointer
columns (`staged_payments.matched_gift_id` / `created_gift_id` /
`group_reconciled_gift_id`, `gifts_and_payments.final_amount_qb_staged_payment_id`)
are `@deprecated` — **never read, never written** (no writes, no null-clears;
revert/reset paths leave any stale legacy values in place as inert history).
Migration 0120 closed the backfill parity gap (every positive-amount legacy link
has a counted ledger row) before the reads flipped, and both the API responses
and the OpenAPI spec no longer expose the four columns. They stay physical,
frozen at their pre-cutover values, until a much-later drop migration (INV-F).
Group membership is now durable in `unit_groups` / `unit_group_members` for
ad-hoc groups too — no representative pointer dance.

- **Flipped to the ledger (all QB unit↔gift reads):** the QB-tie deriver
  (`giftQbTie.ts` reads `qbLedgerSumForGift()` / `qbLedgerExistsForGift()`), the
  workbench's "current link" (`giftsAndPayments.ts` exposes
  `quickbooksStagedPaymentId` via `qbLedgerPaymentIdForGift()`), the derived
  staged-payment status (`derivedStatus.ts`), the reconciliation guards in
  `reconciliation/cards.ts` and `quickbooks/shared.ts`, `reconciliationGraph.ts`,
  and every route in `quickbooks/matching.ts` / `quickbooks/actions.ts` /
  `reconciliation/approve.ts`.
- **NOT a cash-application surface (was mis-listed here):** `coding-form-import.tsx`
  reads/writes `matchedGiftId`, but that is `coding_form_rows.matched_gift_id` — a
  coding-import *staging* pointer (spreadsheet row ↔ gift), **not** a
  `staged_payments`/`stripe_staged_charges` reconciliation link. It is orthogonal to
  the unit↔gift ledger and needs **no** read-flip in Phase 2/3. Leave as-is.
- **Still legacy:**
  Plane 1 settlement is **100% legacy** (`stripe_payouts.qb_reconciliation_status`,
  a 7-value enum, plus `qbSupersedeStatus` + `proposed/matched/conflict` pointer
  columns). The ledger has **no rows** for Stripe charge↔gift or payout↔deposit —
  `stripe_staged_charges.matched_gift_id` / `created_gift_id` and the Donorbox
  equivalents remain the live link columns on those sources.

On top of the links sit **five derived-status projections**:
the gift↔QB tie signal (now LIVE-derived at read time via `giftQbTie.ts`
`deriveGiftQbTieLiveExpr`; the persisted `quickbooks_tie_status` column was
dropped), the two-lane `funding` / `crmRecord` model
(`reconciliationLanes.ts`: `deriveEvidenceLanes` / `derivePayoutLanes`), the payout
`qb_reconciliation_status`, the cards-queue derivation (`routes/reconciliation/cards.ts`
`readyExpr` / `unlinkedDonorGiftWhere`), and the settlement-bundle drafts
(`reconciliationBundleProposal.ts` + the graph proposer `reconciliationGraph.ts`).

And **six UI queues** (`reconciliation-workbench.tsx` + `reconciliation.ts`):
Settlement Bundles, Needs Review, QBO-only, CRM-only, Research, Excluded.

Nothing old was ever deleted: `@deprecated`-but-still-physical columns, legacy
enum values kept "for history," multiple confirm paths retained for back-compat.

---

## 3. Locked invariants (do not regress)

These carry over unchanged and constrain every phase:

- **INV-A — CRM gift is the single source of truth.** Donor credit is counted
  once, on the gift. External rows (Stripe payout / charge, QB deposit / payment
  line, Donorbox donation) are permanent **evidence**: they are never themselves a
  gift and are never archived to deduplicate money (the D4 invariant). Confirming a
  match *stamps* evidence; it never archives it.
- **INV-B — Book-once in the service layer.** A single unit of money may not be
  applied to gifts for more than it is worth. Enforced by `UNIQUE(source, gift)` +
  a tx row-lock + a live `SUM(amount_applied)` check (`checkBookOnce`), **not** by a
  DB aggregate/fee-band constraint. This stays true after unification.
- **INV-C — Donor XOR.** Every gift (and every staged/charge/donation candidate at
  reconcile time) has exactly one donor: organization / individual / household.
  Unchanged.
- **INV-D — Fee tolerance lives in the service layer.** Gross-vs-net comparisons use
  `amountWithinFeeBand` at confirm time; the ledger stores exact `amount_applied`.
- **INV-E — Match state is orthogonal to classification.** Funding source, entity
  attribution, exclusion reason, and the revenue-coding snapshot describe the money;
  they are **not** part of the match state machine and must not gate matching.
- **INV-F — Prod-safe, human-applied data changes.** The agent never writes prod.
  Schema/code ship via Publish; every prod **data** change is a reviewed, idempotent
  SQL file in `lib/db/migrations/`, applied by a human. Every phase is additive →
  dual-write → backfill → **prod parity** → flip reads → deprecate → drop much later.
- **INV-G — Sync owns evidence; CRM associations are additive.** Every external
  evidence row (Stripe payout / charge, QB deposit / payment line, Donorbox
  donation) is a mirror of source data **owned by the sync**: its immutable source
  facts (amount, date, source ids, raw payload) are re-asserted on every pull and
  must never be mutated, split, or deleted by the reconciliation UI to express a
  relationship. **Classification fields are the deliberate exception:** `entity_id`,
  `funding_source`, and the exclusion reason carry an `auto | manual` provenance, and
  a **manual** value is a CRM annotation the sync must *preserve* across re-pull
  (today's preserve-on-conflict upsert) — it is a human override, not a source fact.
  All CRM-side associations — unit↔gift links (`payment_applications`), batch↔batch
  links (`settlement_links`), unit↔unit groups (§4.6), and gift-combine provenance —
  live in **separate CRM columns or tables**. The two cleanup operations (§4.6) are
  therefore *re-associations*, never edits to the source mirror; anything the sync
  can re-derive from source (and no human has manually overridden) stays sync-owned.

---

## 4. Target model (the simpler end-state)

### 4.1 Two record kinds

- **Evidence** from external money systems, in two grains:
  - *batch:* Stripe payout, QB deposit.
  - *unit:* Stripe charge, QB payment line (SalesReceipt / Payment / deposit line),
    Donorbox donation — **plus their reversals** (a QB Refund Receipt / credit /
    negative-deposit line, a Stripe refund / dispute), which are ingested as
    unit-grain evidence rows too (§4.2a).
- **CRM gifts** — the single source of truth for donor credit (INV-A).

### 4.2 One link ledger for the unit↔gift plane

Generalize `payment_applications` into **the** link record for Plane 2 across all
three unit sources. Every row is one statement: *"this much of this unit of money
is applied to this gift."*

Target columns (evolution of today's `payment_applications`):

| Column | Meaning / change from today |
| --- | --- |
| `id` | unchanged |
| `evidence_source` | `quickbooks` \| `stripe` \| `donorbox` — already exists |
| `source_id` | **new polymorphic unit ref** (points at `staged_payments.id`, `stripe_staged_charges.id`, or `donorbox_donations.id` per `evidence_source`). Replaces today's `payment_id` (NOT NULL → QB-only) + the parallel `stripe_charge_id` / `donorbox_donation_id` columns. See Decision 1 for why the current shape blocks Stripe units. |
| `gift_id` | unchanged (RESTRICT; header grain — the tie SUM is per-gift) |
| `gift_allocation_id` | unchanged (optional annotation; **not** required or used by tie math — ties are gift-grain, see Decision 6) |
| `amount_applied` | unchanged (> 0), **except** the §4.2a reversing refund row, which carries the opposite sign so a refund nets its original to zero |
| `link_role` | **new:** `counted` \| `corroborating`. Only `counted` rows enter the book-once SUM and the tie/settled derivations. `corroborating` folds in `gift_evidence_links` (Decision 2). |
| `lifecycle` | **new:** `proposed` \| `confirmed` \| `exempt`. Replaces the "is it applied yet" signal that today is smeared across `status`/`match_confirmed_at`/`auto_applied`. |
| `provenance` | **new:** `system` \| `system_confirmed` \| `human`. Generalizes today's `match_method` + `auto_applied`. |
| `created_the_gift` | unchanged (preserves mint-ownership; the row that minted the gift) |
| `confirmed_by_user_id` / `confirmed_at` | unchanged |
| `note` | unchanged |

Book-once key becomes `UNIQUE(evidence_source, source_id, gift_id)` **filtered to
`link_role = 'counted'`** (a corroborating link may coexist with the counted one).
The `SUM` check and tx row-lock filter on `link_role = 'counted'` too.

This single table **retires**: all six evidence→gift pointer columns
(`matched_gift_id` / `created_gift_id` / `group_reconciled_gift_id` on
`staged_payments`, `matched_gift_id` / `created_gift_id` on
`stripe_staged_charges` and `donorbox_donations`), the `staged_payment_splits`
table, `gift_evidence_links`, and `gifts_and_payments.final_amount_*` (already
`@deprecated`). The stock "representative + `group_reconciled_gift_id`" dance
collapses into plain **N counted ledger rows → one gift**.

### 4.2a Refunds & chargebacks net to zero in the ledger

Refund detection is **first-class** and extended to **both** sources: today only
Stripe refunds/disputes are propagated; QB refunds (a Refund Receipt / credit /
negative-deposit line) are detected the same way. A detected refund is booked into
the *same* ledger as the money it reverses — a **reversing counted row** on the
refund unit, pointed at the same gift — so the original `+X` and the refund `−X`
**cancel each other out**. The gift's `SUM(counted amount_applied)` then returns to
`0` and it derives `unreconciled` — it reads as **no payment at all** (§4.4),
instead of a reconciled gift silently going stale. (This is the one place the
`amount_applied > 0` invariant is relaxed to allow the reversing sign; the reversal
stays in the ledger so book-once (INV-B) and every derived status remain correct
without a side channel.) A partial refund nets partially → the gift drops to
`partial`; a full refund or chargeback nets to zero and the emptied gift follows the
existing propagation subsystem's archive rules. The refund itself is a real ingested
unit-grain evidence row (per source, §4.1), so the reversing ledger row has a
concrete `source_id` to hang on — it is an ordinary unit whose only application is
the reversal.

### 4.3 A small settlement-link table for Plane 1

Give batch↔batch its own purpose-built table (Decision 1) — call it
`settlement_links`:

| Column | Meaning |
| --- | --- |
| `id` | pk |
| `payout_id` | FK → `stripe_payouts` |
| `deposit_staged_payment_id` | FK → `staged_payments` (the QB deposit lump line) |
| `lifecycle` | `proposed` \| `confirmed` \| `exempt` |
| `provenance` | `system` \| `system_confirmed` \| `human` |
| `confirmed_by_user_id` / `confirmed_at` | who/when |
| `note` | optional |

> **Latent constraint (record before Phase 7 / any staged-payment delete tooling).**
> The `deposit_staged_payment_id` FK is `ON DELETE SET NULL`, but the
> `settlement_links_deposit_required_chk` CHECK requires a non-`exempt` link to
> carry a deposit. Postgres evaluates CHECKs during a referential SET NULL, so
> hard-*deleting* a `staged_payments` row referenced by a `proposed`/`confirmed`
> link would raise a CHECK violation rather than silently null the pointer. No
> `delete(staged_payments)` path exists in the app today (archive-not-delete), so
> this is latent — but any future staged-payment wipe/delete tooling must first
> clear or re-`exempt` the referencing links.

This **retires** `stripe_payouts.qb_reconciliation_status` (7-value enum),
`qb_supersede_status`, `proposed_qb_staged_payment_id`,
`matched_qb_staged_payment_id`, `qb_conflict_staged_payment_id`,
`qb_conflict_gift_id`, the direct charge→deposit pointer
`stripe_staged_charges.linked_qb_staged_payment_id` (a Stripe charge now reaches QB
*through* its payout's settlement link, §1 — not a per-charge deposit pointer), and
the vestigial `confirmed_keep` / `confirmed_replace` / `conflict_approved` paths
(already partly retired under D4). The payout's settlement status becomes a pure
derivation (§4.4).

**One count across the settlement boundary.** A confirmed settlement link says the
deposit *is* the Stripe payout landing, so the deposit and its constituent charges
are the **same dollars** at two grains. Book-once (INV-B) is per-unit, so it does not
by itself stop both grains from being counted; the model adds the rule explicitly:
when the per-charge Stripe units carry `counted` unit→gift rows, any coarse
deposit→gift `counted` link for that same money is **superseded** (downgraded to
`corroborating`, and a coarse deposit-derived gift archived) so Plane 2 credits the
donor once. This is the durable replacement for today's `processor_payout` exclusion
+ coarse-gift archive (retired above). If there are no per-charge counted units, the
coarse deposit gift simply *stays* the counted record (the old "keep") — either way,
exactly one counted representation per dollar.

> **Shipped interim (2026-07): charge-tie supersede.** The same one-count rule
> already runs today at the *charge-tie* grain for individually-booked payouts
> (`artifacts/api-server/src/lib/chargeTieSupersede.ts`, backfill migration
> 0129). On tie confirm (and in the backfill), a QB `counted` ledger row whose
> amount is the **exact same money** as the tied charge (equals the charge's
> gross OR net, to the cent) is *moved* to the charge grain — a copy is minted
> against the charge (note marker `charge_tie_supersede:<qbId>`) and the QB row
> is demoted to `corroborating`. Anything else (override-mismatch ties, a
> charge already counted for a different gift) is left untouched for human
> review. Derived-status consequence: a charge-grain tie counts as
> `match_confirmed` evidence for the QB row **only when the tied charge itself
> carries a counted ledger row** — raw linkage alone is a *claim* (it blocks
> re-picking the QB row) but never status evidence, so a refunded or
> not-yet-booked tied charge leaves the QB row's `pending`/`excluded` work
> visible (`derivedStatus.ts`: `stagedChargeTieExists` vs
> `stagedChargeTieLinkExists`).

> **Claim-pointer retirement (ADR, 2026-07 — IMPLEMENTED 2026-07-21).** The
> unit-grain evidence↔evidence pointers — `linked_qb_staged_payment_id`,
> `proposed_qb_staged_payment_id`, `linked_fee_qb_staged_payment_id` on
> `stripe_staged_charges`, and the `donorbox_donations` counterparts — were
> replaced by the `source_links` claims table and physically dropped in
> migration 0149. `source_links` is the sole authority for these claims; never
> add a sibling pointer column. See
> [`adr-source-link-ledger.md`](adr-source-link-ledger.md).

### 4.4 One derived status per record per plane (no new stored columns)

All statuses are pure functions over the two link tables (the
`deriveGiftQbTie` / `deriveOppFields` pattern). Nothing is hand-set; nothing new is
persisted.

- **Gift (Plane 2)** → `exempt` \| `reconciled` \| `partial` \| `unreconciled`
  - `exempt` if off-books (all allocations on no-payment entities).
  - else let `s = SUM(amount_applied)` over `counted` ledger rows for the gift:
    `s == 0` → `unreconciled`; `s` within fee band of `gift.amount` → `reconciled`;
    otherwise → `partial`.
  - This replaces `quickbooks_tie_status`'s `tied/amount_mismatch/missing` with a
    source-agnostic vocabulary; the Stripe "tied at payout level" shortcut is no
    longer a special case because Stripe charges now have their own counted rows.
  - **No amount-mismatch override.** When a human confirms a match whose amounts
    differ beyond the fee band, the resolution is to **correct the gift amount** to
    what actually landed — the SUM then reconciles — not a `confirmAmountMismatch`
    flag (B1). Money that is genuinely *reversed* (a refund) is handled by netting in
    the ledger (§4.2a), never by editing the gift amount.
- **Unit (Plane 2)** → `excluded` \| `linked` \| `partial` \| `proposed` \| `orphan`
  (symmetric with the gift side — a unit can be fractionally applied just as a gift
  can be fractionally funded).
  - `excluded` if the unit is classified noise (status `excluded`/`rejected`).
  - else let `u = SUM(amount_applied)` over `confirmed`, `counted` ledger rows for
    the unit:
    - `u` within fee band of the unit's own value → `linked`;
    - `0 < u` below that band → `partial` (money left unapplied — e.g. one big
      deposit split across gifts over time, not yet fully distributed).
  - `proposed` if `u == 0` and only a `proposed` row (or a suggested donor/gift)
    exists.
  - else `orphan` (donor not credited).
- **Batch (Plane 1)** → `settled` \| `proposed` \| `orphan`
  - `settled` if a `confirmed` settlement link exists.
  - `proposed` if only a `proposed` one exists.
  - else `orphan` (an orphan payout = money left Stripe but never booked; an orphan
    QB deposit that looks like Stripe = booked but no payout).

**Two-lane view kept, unified source (Decision 3).** The evidence-unit status above
is the *headline*. The finer **funding / crmRecord** two-lane projection stays —
it usefully separates "is the money tied to a gift" from "is the donor confirmed" —
but both lanes are derived **only** from the ledger + the unit's donor-XOR columns,
replacing today's mix of ledger reads and legacy `qb_reconciliation_status` reads
(`deriveEvidenceLanes` / `derivePayoutLanes` collapse to one deriver each, sourced
from the links).

### 4.5 Two three-column reports (UI) — **RETIRED / won't-build (2026-07)**

> **Status: retired.** This UI collapse (Phase 6) was never built and has been
> formally closed as won't-do. The current **six-queue workbench is the accepted
> end state**. The section is kept for the record of what was considered.

The retired plan: collapse the six queues into **two reports with the same shape —
Matched | Missing-left | Missing-right:**

1. **Settlement report** — Stripe payouts ↔ QB deposits. Orphan columns are the two
   accounting/payout signals (§4.4 batch).
2. **Gift report** — units ↔ gifts, with a **funding-source filter**
   (Stripe / QB-direct / Donorbox) so "Stripe charges vs gifts" and "checks/ACH vs
   gifts" are slices of *one* report. Orphan columns are "donor not credited" and
   "gift with no money."

"**Needs review**" becomes a *filter* (a `proposed` link awaiting confirm), not a
queue. "**Research**" stays a flag (`needs_research`). "**Excluded**" and
classification (exclusion reason, funding source, entity, coding snapshot) are
**orthogonal to matching** (INV-E) — kept, but decoupled from the match state
machine.

### 4.6 Two non-destructive cleanup operations

Real data arrives mis-coded in two symmetric ways, and the interface must let a
fundraiser repair both **without ever touching the sync-owned evidence** (INV-G).
The two errors are duals — one on the gift side, one on the evidence side:

**(a) CRM over-split → combine gifts.** When one real gift was entered as several
gifts (e.g. one grant typed in once per restriction), collapse them into **one gift
with several allocation rows.**
- *Today:* `POST /gifts-and-payments/merge` already moves every loser's allocation
  rows onto the survivor and sums the amount — but it **hard-deletes** the losers
  and **blocks (409) when any loser is QB / Stripe / ledger-linked**, precisely to
  avoid severing reconciliation history.
- *Target:* combine becomes ledger-aware. Instead of blocking a linked loser, it
  **re-points that loser's counted (and corroborating) ledger rows onto the
  survivor** inside the merge tx and recomputes the survivor's derived tie status
  (§4.4). Evidence rows are untouched — only `payment_applications.gift_id` moves.
  Book-once (INV-B) is a per-*unit* SUM, so re-pointing changes no unit's total on
  its own; the one hazard is a **key collision** — when the survivor and a loser each
  already hold a `counted` row for the *same* unit (one deposit split across the very
  gifts being combined — the classic over-split), a naïve re-point violates
  `UNIQUE(evidence_source, source_id, gift_id)`. Resolve by **coalescing**: fold the
  colliding rows into one, **sum their `amount_applied`**, and keep the survivor row's
  identity (its `lifecycle` / `provenance` / gift-creating flag win). Corroborating
  rows have no unique key, so **dedupe on re-point**. The survivor ends as one gift
  with N allocation rows and its counted rows summing to its combined amount: the
  ordinary "N units → one gift" shape (§6). Donor is resolved exactly as today's
  `/merge` does — explicit choice required when the gifts disagree (INV-C). Absorbed
  gifts are **archived, not hard-deleted** (the app-wide default supersedes the
  current merge hard-delete exception). This is the exact inverse of the Decision-6
  split (one gift → several one-restriction gifts).

**(b) QB over-split → group units.** *[Superseded 2026-07-23 by
[`adr-linear-money-model.md`](adr-linear-money-model.md): `unit_groups` was
built as designed below, but new group creation is now retired — the workbench
multi-select match writes N counted ledger rows directly, no group record —
and the structure is slated for retirement in ADR §7 step 3. The text below is
kept for the history of existing legacy groups.]* When one real deposit was
booked in QB as several payments (to show different restrictions on parts of
one gift), link those payment **units** together as a single group and match
the group as one — without editing the QB rows.
- *Today:* `staged_payments.source_group_id` already groups QB rows; group-approve
  mints one gift via a "representative + `group_reconciled_gift_id`" pointer dance.
- *Target:* promote grouping into a first-class, durable, sync-safe association: a
  small **`unit_groups`** record (id, optional label, `created_by`, `created_at`,
  note) with **polymorphic `(evidence_source, source_id)` membership** — the same
  shape the ledger uses — so it never needs a grouping column on three different
  evidence tables. The group is a pure CRM annotation: the sync re-asserts each
  member's source facts untouched (INV-G). **Membership is exclusive** — a unit
  belongs to at most one group and, once grouped, matches *only* via its group (a
  member is never matched individually). Matching a grouped set to a gift writes
  **one counted ledger row per member unit** → the gift, each with `amount_applied` =
  that member's own value and the fee-band tolerance (INV-D) applied to the group
  **total**; no representative, no `group_reconciled_gift_id`, so the group reduces to
  the same "N units → one gift" shape and book-once (INV-B) spans the members
  automatically. A group not yet matched reads as one logical unit in the Gift
  report. (Membership is single-source in practice; a cross-source group would need a
  Plane-1 double-count guard and is not built in Phase 3.)

Both operations are re-associations over immutable evidence, so both fit the
prod-safe additive path (§7): the combine's ledger re-point (a) and the
`unit_groups` table (b) are new writes, never destructive rewrites of synced rows.

---

## 5. Open decisions — resolved

### Decision 1 — One ledger table or two? → **Two.**
Extend `payment_applications` to be the single **unit↔gift** ledger across QB /
Stripe / Donorbox (§4.2), and add a small purpose-built `settlement_links` table
for **batch↔batch** (§4.3).

*Why:* the two planes are structurally different. A settlement row has no donor,
no gift, no allocation, no `amount_applied` semantics — folding it into
`payment_applications` with a discriminator makes half the columns permanently
null. More concretely, today's `payment_applications.payment_id` is `NOT NULL →
staged_payments`; a payout↔deposit link's source is a `stripe_payouts` row, which
does not fit that FK. The "one uniform concept" benefit is cosmetic — both are
"link records," but they answer different questions and have different cardinality
and lifecycle. Two focused tables keep every column meaningful.

### Decision 2 — `gift_evidence_links`? → **Fold into the unified ledger** as `link_role = 'corroborating'`.
*Why:* the whole thrust of the task is "one link ledger." The only real difference
between `gift_evidence_links` and `payment_applications` is *counted vs not
counted*, which a single `link_role` discriminator expresses cleanly — the
book-once SUM and every derivation filter on `link_role = 'counted'`, so a
corroborating link can never double-count a dollar (the property that made the
separate table "safe" is preserved). Folding also upgrades the polymorphic,
FK-less `gift_evidence_links` design to real foreign keys.
*Tradeoff to honor:* delete semantics differ by role — `counted` rows are the money
trail (RESTRICT; hard-delete gift paths clear/block first, as today), while
`corroborating` rows are re-derivable annotations (safe to drop on gift
delete/merge). The gift merge/delete paths already clear ledger rows, so they
extend naturally. Financial-corrections code re-points to insert
`corroborating` rows.

### Decision 3 — Two-lane statuses? → **Keep the two lanes, unify their source.**
Keep the `funding` / `crmRecord` split (it encodes a real orthogonality the
worklist needs), but derive **both** lanes purely from the ledger everywhere, and
collapse the duplicate derivations (the payout-enum-fed lane, the mixed
ledger+legacy reads) into one deriver per lane. The per-record-per-plane status
(§4.4) is the headline; the two lanes are an additional pure projection. No stored
status columns.

### Decision 4 — UI aggressiveness? → ~~Incremental collapse, to a locked 2-report IA~~ **SUPERSEDED (2026-07): no UI collapse — the six-queue workbench is the accepted end state.**
The original decision (kept below for the record) was an incremental re-group of
the existing components under the two-report IA of §4.5. That work (Phase 6) was
never built, its planning task was archived, and it has been formally retired as
won't-do: the current six-queue workbench is the accepted, final information
architecture. No 2-report collapse is planned.

*Original (retired) decision:* do **not** do a from-scratch rewrite of the
3,651-line workbench. Re-group the existing, working card/list components under
the two-report information architecture (§4.5); turn "needs review" and
"excluded" into filters; retire the bundles / six-queue *grouping* rather than
the components. *Why (at the time):* prod-safe discipline and lower risk — the
components work; the convolution is the six-way grouping over mixed data sources.

### Decision 5 — Extend the ledger to Stripe (and Donorbox) unit links? → **Yes — ratify the reversal.**
The prior firm decision kept `payment_applications` strictly "QB cash-application."
A single unit↔gift plane is impossible otherwise, because Stripe charges and
non-Stripe Donorbox donations are first-class units (§1, §4.1). The schema already
anticipates this: `payment_applications.evidence_source` already carries
`stripe` / `donorbox`, with matching CHECK constraints. We are ratifying the
deliberate reversal, not inventing it.
*Caveat carried from prior work (see memory `ledger-read-cutover-prod-gate`):* a
read cutover is only safe once **prod** parity runs (dev parity ≠ prod), and any
fixture that seeds a legacy-only link must dual-write the ledger row until the
legacy columns are dropped.

### Decision 6 — Allocation-grain ties & restriction-level reconciliation? → **Tie at the gift (header) grain; split gifts when restriction-level ties are needed.**
A unit↔gift ledger row ties at the **gift** grain. `gift_allocation_id` stays an
optional annotation and is **not** required, populated, or used by tie math for now,
so the tie SUM (and book-once) is purely per-gift and per-unit.

When a single QB payment — or a wire the donor sent as one lump that QB then booked
as several restriction-specific payments — must reconcile *by restriction*, the
fundraiser **splits the CRM gift by allocation into separate one-restriction gifts**
and ties each unit to its own gift. Header-grain tie math is then automatically
restriction-correct, because one gift = one restriction — no per-allocation
derivation is needed.

*Why:* per-allocation tie math is real added complexity for a case the existing
gift-split already expresses cleanly. Deferring it keeps the ledger's SUM purely
per-gift and per-unit and avoids a second grain of "reconciled." Revisit only if
manual splitting proves too costly in practice.

### Decision 7 — How do we model the two cleanup ops (combine gifts / group units)? → **Group via a durable `unit_groups` table; combine via a ledger-aware merge; both additive over immutable evidence.**

> **SUPERSEDED on the grouping half (2026-07-23).**
> [`adr-linear-money-model.md`](adr-linear-money-model.md) retires
> `unit_groups`/`unit_group_members` (and the legacy `source_group_id`):
> multi-select match writes N counted ledger rows atomically, and the ledger
> alone expresses the combined outcome. That ADR also migrates the counted
> anchor for non-Stripe money from QB payment rows to bank-deposit units in
> its Layer 2 target. The gift-combine half of this decision stands.

Unit grouping becomes a first-class `unit_groups` record + polymorphic membership
(§4.6b), generalizing today's `staged_payments.source_group_id`. Gift combine
re-points the losers' ledger rows onto the survivor rather than blocking on a
QB / Stripe link (§4.6a). Neither ever mutates or deletes an evidence row (INV-G).

*Why:* the two data errors are duals (over-split gift vs over-split deposit), and
each already has a partial mechanism in the code (`/merge`, `source_group_id`).
Making grouping a durable table — not an ad-hoc string that exists only to seed a
mint — lets a group persist and display as one logical unit before and after
matching, while keeping the evidence rows pristine for the sync to re-own.
Re-pointing the ledger on combine (instead of today's 409) is what lets us clean up
already-reconciled over-splits — the common real case — without severing history.

---

## 6. Correctness checklist (scenarios the model must express)

| Scenario | Today | Target |
| --- | --- | --- |
| **Stock / brokerage gift** (many QB units → one gift, amounts differ, different dates) | *was* group-reconcile "representative + `group_reconciled_gift_id`" + `confirmAmountMismatch` override — retired 2026-07-23; the target shape is live as `POST /quickbooks/staged-payments/multi-match` | **N counted ledger rows** → one gift, each with its own `amount_applied`; within the fee band it reconciles automatically. Beyond the band (brokerage fees, a write-off) there is **no mismatch override** — the human corrects the gift amount to what actually landed and the SUM reconciles (B1). No representative, no second pointer column. |
| **Donorbox donation duplicating another source** (cross-source dedupe) | ad-hoc linked/excluded | the *settling* record is the **counted** unit — the QB payment for a pay-by-check, or the **Stripe charge** for a Donorbox-through-Stripe donation (clean 1:1 via `donation.stripe_charge_id`) — while the Donorbox row is a **corroborating** ledger row (or excluded `already_booked`). Same money signalled by Donorbox, counted once. |
| **Donorbox PayPal → new-money unit** (no batch leg) | non-Stripe new-money worklist row | first-class **counted** unit that mints/links a gift. Flagged: PayPal units have **no Plane-1 settlement leg** (only Stripe payouts↔QB deposits are batch-reconciled) — they tie to the books only via an eventual QB deposit, if at all. A known gap, not solved here. |
| **Bulk deposit** (one QB unit → many gifts) | `gift_evidence_links` corroboration | **N counted ledger rows** from one deposit unit to many gifts (M:N in the other direction); the deposit's own `amount_applied` sums across them within book-once. The deposit unit reads `partial` until its applied sum reaches its value, then `linked` (§4.4). |
| **Restriction-split wire** (one $1M wire QB-booked as several restricted payments) | ad-hoc grouping | Two supported shapes, both **gift-grain** (Decision 6): (a) one multi-allocation CRM gift — tie all the QB payments to that single gift, reconciled when the SUM hits the gift total (no per-restriction check); (b, preferred when restriction-level ties matter) split into **several one-restriction gifts** and tie each QB payment 1:1 to its gift, which makes header-grain tie math restriction-correct for free. |
| **Stripe payout matches an already-booked QB deposit** (old `conflict_approved` / conflict-keep) | payout flagged `conflict_approved`; a `confirmed_keep` path + a double-book gate guard the deposit's existing gift; per-track status so it doesn't read as a discrepancy | the *settlement* confirm is **Plane 1 only** (payout↔deposit, no gift) — no conflict enum, no keep/replace path. The real hazard (the deposit's coarse gift and the payout's per-charge Stripe gifts counting the same dollars twice) is handled by the **one-count-across-the-settlement-boundary** rule (§4.3): per-charge counted units supersede the coarse deposit→gift link (else the coarse gift stays the counted record). |
| **Over-split CRM gift** (one grant entered as several gifts) | `/gifts-and-payments/merge` moves allocations + sums, but hard-deletes losers & 409s on any QB/Stripe link | ledger-aware **combine** (§4.6a): re-point each loser's counted/corroborating ledger rows onto the survivor, re-check book-once, recompute tie; one gift with N allocation rows; absorbed gifts archived, evidence untouched. |
| **Over-split QB deposit** (one deposit booked as several restriction payments) | `source_group_id` + representative `group_reconciled_gift_id` mint | durable **`unit_groups`** association (§4.6b, polymorphic membership); matching the group writes one counted ledger row per member → one gift; QB rows never edited (INV-G). *Superseded 2026-07-23: new group creation is retired — the same N-counted-rows shape now ships as multi-match with no group record; `unit_groups` is slated for retirement (see the header banner and [`adr-linear-money-model.md`](adr-linear-money-model.md)).* |
| **Refunded / charged-back payment** (a QB refund record, or a Stripe refund/dispute) | Stripe-only propose-then-confirm reduces/archives the gift; QB refunds not detected | refund detection is first-class on **both** sources; the refund is a **reversing counted ledger row** that cancels its original (§4.2a), so the gift's counted SUM returns to 0 and it reads as **no payment at all**. Partial refund → `partial`; full refund/chargeback → `unreconciled` + archive per the propagation subsystem. |

---

## 7. Prod-safe phased migration path

Each phase is independently shippable and reversible, follows INV-F (additive →
dual-write → backfill → **prod parity** → flip reads → deprecate → drop much
later), and is its own human-gated task. The original design task delivered only
Phase 1 (this document); Phases 2–7 were sequenced as follow-on tasks.

> **Implementation status (updated 2026-07) — this banner supersedes the inline
> "Progress / holdout / blocking" notes under each phase below, which predate
> migrations 0089–0094 and now lag the code.**
>
> - **Phases 2–5: SHIPPED** (migrations 0086–0093). The unit↔gift cash-application
>   ledger (`payment_applications`, with `link_role` + `lifecycle`, backfilled for
>   Stripe/Donorbox) and the Plane-1 `settlement_links` table are the authoritative
>   stores; batch and gift statuses derive from them. `settlement_links` is now the
>   **sole** payout↔deposit store — the 7-value `stripe_payouts.qb_reconciliation_status`
>   mirror + pointer columns (0093) and the `gift_evidence_links` table (0091) have
>   been dropped, and `conflict_gift_id` moved onto `settlement_links` (0092). The
>   write-flip and enum retirement that the Phase-4 note below calls "still required"
>   are **done**.
>   - *By-design remainder (not a holdout):* `giftPaymentSummary.ts` still reads
>     processor **fees** from `stripe_staged_charges` / `donorbox_donations` because
>     fees are not modelled in the ledger. This is intentional and permanent.
> - **Phase 6 (two-report UI): RETIRED — won't build (2026-07).** The two-report
>   collapse was never built and is formally closed as won't-do. The accepted UI
>   design is now the **cluster view** (`reconciliation-clusters.tsx`) — one unified
>   row per cluster carrying all three facets, with lens-based filtering. It
>   supersedes the old six-queue workbench (`reconciliation-workbench.tsx`).
> - **Phase 7 (deprecate → drop): partial.** Dropped so far: `gift_evidence_links`
>   (0091), the `stripe_payouts` recon mirror (0093), `gift_allocations.counts_toward_goal`
>   (0094), and `staged_payments.source_group_id` + its index (0104 — superseded by
>   `unit_groups`; a read-only prod parity run of the 0088 backfill was clean, and
>   the one-shot parity scripts that were its last readers have been retired/deleted),
>   and `staged_payment_splits` (0115 — split semantics folded into counted
>   `payment_applications` rows; a split staged row carries NONE of the three
>   gift-link columns and its resolution lives entirely in the ledger).
>   Remaining §7 candidates are NOT sweepable yet: the dead-looking
>   enum values (`processor_payout`, `confirmed_excluded`) are still read by the
>   revert paths. **Caution:** several
>   `@deprecated`-labelled `gifts_and_payments` columns (`quickbooks_tie_status`,
>   `final_amount_source` and the `final_amount_*` provenance pointers) are STILL
>   actively read/written by live code (lane derivation, the gifts filter, QB
>   matching/actions, financial corrections). Their "no longer read or written"
>   comments are aspirational — these are **not** drop-ready yet.
> - **Group mechanism collapse: SHIPPED (2026-07-23), beyond this document.**
>   The stock group-reconcile "representative" dance is retired, and so is new
>   group *creation* itself: `POST /staged-payments/multi-match` writes N counted
>   ledger rows → one gift atomically, with no group record. `unit_groups`
>   remains only for legacy groups and is slated for retirement — see
>   [`adr-linear-money-model.md`](adr-linear-money-model.md) §7.

1. **Ratify the spec** *(this task)*. Commit this document as the target. Lock
   INV-A…INV-G. No code behavior change.

2. **Finish the QB unit↔gift read-flip.** Move the remaining legacy-column reads
   onto the ledger — the last cash-application read surface is
   `reconciliation/gifts-missing-qb.ts`'s Stripe-tied predicate (now
   `stripeLedgerExistsForGift()` / `donorboxLedgerExistsForGift()`). (The gift-tie
   deriver `giftQbTie.ts` is already source-agnostic over counted ledger rows.)
   `coding-form-import.tsx`'s `matchedGiftId` is a coding-import staging pointer,
   NOT a cash-application link — out of scope (see §2). Keep dual-write for rollback.
   Gate on a green **prod** parity run (`parity-reconciliation-guards.ts`:
   legacy-linked == ledger-linked per anchor).

3. **Bring all remaining unit↔gift links into the ledger.** Add the polymorphic
   `source_id` + `link_role` + `lifecycle` + `provenance` columns (§4.2). Write
   ledger rows for Stripe charge↔gift and non-Stripe Donorbox donation↔gift;
   dual-write with the legacy pointer columns; backfill; **prod parity**; flip
   reads. Collapse the stock group-reconcile mechanism into plain N counted ledger
   rows. After this the entire unit↔gift plane is ledger-backed across all three
   unit sources. Two cleanup ops (§4.6) land on this ledger foundation: make gift
   **combine** ledger-aware (re-point the losers' rows onto the survivor instead of
   409-ing on QB/Stripe links; archive absorbed gifts rather than hard-delete), and
   add the `unit_groups` table + polymorphic membership, backfilled from today's
   `source_group_id`, so a grouped set matches as one counted ledger row per member.

   *Progress — Stripe/Donorbox counted gift-TIE read-flip DONE (shipped,
   prod-parity clean).* `deriveGiftQbTie` / `applyGiftQbTieMany` now read Stripe AND
   Donorbox counted rows from the ledger via PER-SOURCE PRECEDENCE (QB sum wins,
   else Stripe, else Donorbox — deliberately NOT a cross-source SUM, which would
   ~2× double-count a gift carrying both a coarse QB deposit line and its per-charge
   Stripe rows); the amount-blind `final_amount_source==='stripe'` shortcut is gone.
   A read-only **prod** run of `parity-stripe-donorbox-readflip.ts` was parity-clean
   (0 tie-status changes; the cross-source pairs it enumerates are exactly the ones
   precedence protects).

   *Progress — group-mechanism collapse DONE (2026-07-23), but not as written
   here.* The "stock group-reconcile → N counted ledger rows" collapse shipped as
   `POST /staged-payments/multi-match`, and the `unit_groups` cleanup op this
   phase describes is **superseded**: new group creation is retired (410) and the
   built `unit_groups` structure is slated for retirement — see the §7 banner and
   [`adr-linear-money-model.md`](adr-linear-money-model.md). Gift **combine** is
   ledger-aware as designed (re-homes counted rows per anchor, archives absorbed
   gifts).

   *Holdout — the money-total surface is intentionally still legacy, folded into
   Phase 4 (below).* `giftPaymentSummary.ts` (`settledGross` / `totalFees` /
   `hasLinkedPayment`) still reads Stripe from `stripe_staged_charges` and Donorbox
   from `donorbox_donations`, for two reasons a bare read-swap cannot resolve: (1)
   processor FEES (`fee_amount` / `processing_fee`) are not modelled in the ledger
   at all, so `totalFees` must stay on the processor tables regardless; and (2)
   `settledGross` is a cross-source SUM, so a gift settled by both a coarse QB
   deposit AND its per-charge Stripe rows already double-counts — the fix is not a
   source-swap but Phase 4's `settlement_links` reclassification of the coarse QB
   row to `link_role='corroborating'`, which is what finally makes the single
   all-source `SUM(counted amount_applied)` of §4.4 correct. `cards.ts`'s per-charge
   gift pointer is the anchor row's own link (the Phase-6 UI replacement was later
   retired — the six-queue workbench stays). Phase 5 was
   allowed to proceed because corroborating links are money-total-neutral (excluded
   from every counted SUM), so the temporary asymmetry (corroborating Stripe/Donorbox
   links in the ledger while their counted siblings are still read via legacy) is
   harmless.

4. **Model Plane 1 settlement as links.** Add `settlement_links` (§4.3). Backfill
   from `stripe_payouts.qb_reconciliation_status`: ALL `confirmed_*` (including
   `confirmed_excluded`) → a `confirmed` link, `proposed`/`conflict_approved` →
   `proposed`, `unmatched` → no link. The `exempt` lifecycle is reserved for links
   with no expected QB deposit — a `confirmed_excluded` payout is **not** exempt:
   the coarse QB lump was suppressed to avoid double-counting the per-charge Stripe
   gifts, but the payout itself is a *confirmed settlement* (the exclusion is a
   Plane-2 fact on `staged_payments.exclusion_reason`, not a payout-settlement
   state). Parity, flip reads to the derived batch status (§4.4). Retire the
   7-value enum and the vestigial confirm paths.

   *Progress — payout reconciliation READ-flip done (additive, parity-gated).*
   The payout list (`stripe.ts`), the unified bundle-anchor enumeration
   (`bundleAnchors.ts`), and the reconciliation card queue (`cards.ts`) now read
   the payout↔deposit tie from `settlement_links` (proposed vs confirmed
   lifecycle) instead of `stripe_payouts.qb_reconciliation_status` + the pointer
   columns. `derivePayoutLanes` takes the settlement-link lifecycle. Dual-write is
   retained for rollback; the read-flip is parity-equivalent for production shapes
   (a `proposed`/`confirmed` status always carries the matching deposit pointer) —
   `deriveSettlementLinkFields` maps degenerate status/pointer mismatches to *no
   link*, which cannot occur in prod. **ONE deliberate read delta:** a
   `confirmed_excluded` payout's funding lane (`derivePayoutLanes`, a derived
   display projection in the payout-list response) now reads `confirmed` instead of
   the old `exempt` — it IS a confirmed settlement (see the step-4 mapping above).
   The parity gate **cannot** catch this: it checks mirror↔deriver consistency, not
   reads↔legacy-lane semantics, and dev holds zero `confirmed_excluded` rows.
   Gate: `parity-settlement-links.ts` (dev PASS; **prod parity + a read-only check
   of prod's `confirmed_excluded` population still required before deprecating** the
   enum/pointers).
   **Still legacy (KEPT on purpose):** `reconQueueWhere` in `stripe.ts`, the
   7-value `status_label` in `bundleAnchors.ts`, and the raw
   `qb_reconciliation_status` blob in `cards.ts` — none is reconstructible from the
   3-value lifecycle. **Blocking dependency for the enum/pointer DROP:** the
   confirm state machine still writes `qbConflictGiftId` + the pointer columns; a
   follow-on WRITE-flip (port confirm onto `settlement_links`) is required first,
   because `conflict_approved` is NOT vestigial (the 7→3 lifecycle collapse is
   lossy).

5. **Resolve `gift_evidence_links`** (Decision 2). Migrate its rows to
   `link_role = 'corroborating'` ledger rows; re-point financial corrections;
   drop the table (deprecate-then-drop).

6. ~~**Collapse the UI to two three-column reports** (Decision 4 / §4.5).~~
   **RETIRED — won't build (2026-07).** The two-report collapse was never built and
   is formally closed as won't-do. The accepted UI design is the **cluster view**
   (`reconciliation-clusters.tsx`) — one unified row per cluster carrying all three
   facets (CRM gift, transaction evidence, bank/accounting record), with lens-based
   filtering. It supersedes the old six-queue workbench (`reconciliation-workbench.tsx`).
   The original step — re-group under a Settlement report and a Gift report, retire
   the cards / bundles / six-queue derivations — is kept here only as a record of the
   considered-but-rejected design.

7. **Deprecate, then (much later, human-gated) drop legacy.** Mark the retired
   pointer columns, `staged_payment_splits` (dropped in 0115),
   `staged_payments.source_group_id`
   (superseded by `unit_groups`, §4.6b), `gift_evidence_links`, and dead enum values
   `@deprecated`; scrub them from API responses (one scrubbed projection — see memory
   `deprecated-column-response-leak`); schedule the physical DROP as reviewed SQL only
   once no live code or prod read touches them.

---

## 8. Out of scope

- Changing the **matching heuristics** (email/name/amount/date/fee-band scoring,
  thresholds, intermediary/memo parsing). This is about the *link model and
  surfaces*, not matcher accuracy.
- Refund / chargeback **detection heuristics** — *how* a refund is spotted and
  paired to its original (the `stripe-refund-propagation` subsystem, now extended to
  QB refund records). Tuning the detector is out of scope; the model **does** cover
  the *ledger effect* — a detected refund nets its original to zero (§4.2a).
- Pledge `paid_amount` derivation (a separate 1:N, intentionally not in the
  ledger).
- Ingestion / classification (funding source, entity attribution, exclusion rules,
  revenue coding) beyond **decoupling** them from the match state machine (INV-E).
- Executing phases 2–7 — each becomes its own human-gated task once this design is
  accepted.
