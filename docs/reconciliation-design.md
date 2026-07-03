# Reconciliation — Target-State Design (ratified)

**Status:** ratified design. This document is the committed target for the
reconciliation subsystem. It changes **no code behavior**; it locks the model,
resolves the open decisions, and defines the prod-safe phased path. Each phase
below (2–7) becomes its own human-gated task once this design is accepted.

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

The ledger cutover is **half-done**. The system **dual-writes** to both the legacy
pointer columns and `payment_applications` (`reconciliationCommit.ts`:
`applyPaymentApplication` called inside `mintGiftInTx` / `linkGiftInTx`). Reads are
**partially flipped**:

- **Flipped to the ledger:** the QB-tie deriver (`giftQbTie.ts` reads
  `qbLedgerSumForGift()` / `qbLedgerExistsForGift()`), the workbench's "current
  link" (`giftsAndPayments.ts` exposes `quickbooksStagedPaymentId` via
  `qbLedgerPaymentIdForGift()`), the reconciliation guards in
  `reconciliation/cards.ts` and `quickbooks/shared.ts`, and `reconciliationGraph.ts`.
- **NOT a cash-application surface (was mis-listed here):** `coding-form-import.tsx`
  reads/writes `matchedGiftId`, but that is `coding_form_rows.matched_gift_id` — a
  coding-import *staging* pointer (spreadsheet row ↔ gift), **not** a
  `staged_payments`/`stripe_staged_charges` reconciliation link. It is orthogonal to
  the unit↔gift ledger and needs **no** read-flip in Phase 2/3. Leave as-is.
- **Still legacy:**
  Plane 1 settlement is **100% legacy** (`stripe_payouts.qb_reconciliation_status`,
  a 7-value enum, plus `qbSupersedeStatus` + `proposed/matched/conflict` pointer
  columns). The ledger has **no rows** for Stripe charge↔gift or payout↔deposit.

On top of the links sit **five derived-status projections**:
`gifts_and_payments.quickbooks_tie_status` (now derived+persisted via
`giftQbTie.ts`), the two-lane `funding` / `crmRecord` model
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

### 4.5 Two three-column reports (UI)

Collapse the six queues into **two reports with the same shape —
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

**(b) QB over-split → group units.** When one real deposit was booked in QB as
several payments (to show different restrictions on parts of one gift), link those
payment **units** together as a single group and match the group as one — without
editing the QB rows.
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

### Decision 4 — UI aggressiveness? → **Incremental collapse, to a locked 2-report IA.**
Do **not** do a from-scratch rewrite of the 3,651-line workbench. Re-group the
existing, working card/list components under the two-report information
architecture (§4.5); turn "needs review" and "excluded" into filters; retire the
bundles / six-queue *grouping* rather than the components. The end-state IA is
locked here so a later full rebuild, if ever wanted, still lands in the same place.
*Why:* prod-safe discipline and lower risk — the components work; the convolution
is the six-way grouping over mixed data sources, which is what we remove.

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
| **Stock / brokerage gift** (many QB units → one gift, amounts differ, different dates) | group-reconcile "representative + `group_reconciled_gift_id`" + `confirmAmountMismatch` override | **N counted ledger rows** → one gift, each with its own `amount_applied`; within the fee band it reconciles automatically. Beyond the band (brokerage fees, a write-off) there is **no mismatch override** — the human corrects the gift amount to what actually landed and the SUM reconciles (B1). No representative, no second pointer column. |
| **Donorbox donation duplicating another source** (cross-source dedupe) | ad-hoc linked/excluded | the *settling* record is the **counted** unit — the QB payment for a pay-by-check, or the **Stripe charge** for a Donorbox-through-Stripe donation (clean 1:1 via `donation.stripe_charge_id`) — while the Donorbox row is a **corroborating** ledger row (or excluded `already_booked`). Same money signalled by Donorbox, counted once. |
| **Donorbox PayPal → new-money unit** (no batch leg) | non-Stripe new-money worklist row | first-class **counted** unit that mints/links a gift. Flagged: PayPal units have **no Plane-1 settlement leg** (only Stripe payouts↔QB deposits are batch-reconciled) — they tie to the books only via an eventual QB deposit, if at all. A known gap, not solved here. |
| **Bulk deposit** (one QB unit → many gifts) | `gift_evidence_links` corroboration | **N counted ledger rows** from one deposit unit to many gifts (M:N in the other direction); the deposit's own `amount_applied` sums across them within book-once. The deposit unit reads `partial` until its applied sum reaches its value, then `linked` (§4.4). |
| **Restriction-split wire** (one $1M wire QB-booked as several restricted payments) | ad-hoc grouping | Two supported shapes, both **gift-grain** (Decision 6): (a) one multi-allocation CRM gift — tie all the QB payments to that single gift, reconciled when the SUM hits the gift total (no per-restriction check); (b, preferred when restriction-level ties matter) split into **several one-restriction gifts** and tie each QB payment 1:1 to its gift, which makes header-grain tie math restriction-correct for free. |
| **Stripe payout matches an already-booked QB deposit** (old `conflict_approved` / conflict-keep) | payout flagged `conflict_approved`; a `confirmed_keep` path + a double-book gate guard the deposit's existing gift; per-track status so it doesn't read as a discrepancy | the *settlement* confirm is **Plane 1 only** (payout↔deposit, no gift) — no conflict enum, no keep/replace path. The real hazard (the deposit's coarse gift and the payout's per-charge Stripe gifts counting the same dollars twice) is handled by the **one-count-across-the-settlement-boundary** rule (§4.3): per-charge counted units supersede the coarse deposit→gift link (else the coarse gift stays the counted record). |
| **Over-split CRM gift** (one grant entered as several gifts) | `/gifts-and-payments/merge` moves allocations + sums, but hard-deletes losers & 409s on any QB/Stripe link | ledger-aware **combine** (§4.6a): re-point each loser's counted/corroborating ledger rows onto the survivor, re-check book-once, recompute tie; one gift with N allocation rows; absorbed gifts archived, evidence untouched. |
| **Over-split QB deposit** (one deposit booked as several restriction payments) | `source_group_id` + representative `group_reconciled_gift_id` mint | durable **`unit_groups`** association (§4.6b, polymorphic membership); matching the group writes one counted ledger row per member → one gift; QB rows never edited (INV-G). |
| **Refunded / charged-back payment** (a QB refund record, or a Stripe refund/dispute) | Stripe-only propose-then-confirm reduces/archives the gift; QB refunds not detected | refund detection is first-class on **both** sources; the refund is a **reversing counted ledger row** that cancels its original (§4.2a), so the gift's counted SUM returns to 0 and it reads as **no payment at all**. Partial refund → `partial`; full refund/chargeback → `unreconciled` + archive per the propagation subsystem. |

---

## 7. Prod-safe phased migration path

Each phase is independently shippable and reversible, follows INV-F (additive →
dual-write → backfill → **prod parity** → flip reads → deprecate → drop much
later), and is its own human-gated task. **Phases 2–7 are out of scope for this
task** — this task delivers only the ratified design (Phase 1).

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

4. **Model Plane 1 settlement as links.** Add `settlement_links` (§4.3). Backfill
   from `stripe_payouts.qb_reconciliation_status` (map `confirmed_*` → a
   `confirmed` link, `proposed` → `proposed`, `confirmed_excluded` →
   `exempt`/excluded QB row as today). Parity, flip reads to the derived batch
   status (§4.4). Retire the 7-value enum and the vestigial confirm paths.

5. **Resolve `gift_evidence_links`** (Decision 2). Migrate its rows to
   `link_role = 'corroborating'` ledger rows; re-point financial corrections;
   drop the table (deprecate-then-drop).

6. **Collapse the UI to two three-column reports** (Decision 4 / §4.5). Re-group
   the existing components under the Settlement report and the Gift report (with the
   funding-source filter). Retire the cards / bundles / six-queue *derivations*;
   "needs review" and "excluded" become filters. Surface the two §4.6 cleanup actions
   in the **Gift report** (the unit/gift-grain surface): **combine** selected gifts
   and **group** selected units — each a re-association over immutable evidence
   (INV-G). (Plane-1 batch↔batch grouping is out of scope; the Settlement report
   stays payout↔deposit.)

7. **Deprecate, then (much later, human-gated) drop legacy.** Mark the retired
   pointer columns, `staged_payment_splits`, `staged_payments.source_group_id`
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
