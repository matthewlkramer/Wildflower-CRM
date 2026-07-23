---
status: ratified
last_verified: 2026-07-23
---

# ADR: Linear money model — gift = payment event, bank-anchored evidence tree

**Status:** Ratified 2026-07-23 (design discussion with owner; production-data
analysis + architecture review). Implementation is under way — §7 steps 1–3
are done (step 2: `POST /quickbooks/staged-payments/multi-match` writes N
counted rows atomically; the group and group-reconcile endpoints are 410
stubs, so no new unit groups can be created; step 3: every unit-group read
and behavior is retired — nothing reads or writes `unit_groups` /
`unit_group_members` any more; the tables persist as inert legacy data until
step 4 drops them). Steps 4–6 are not started; see §7 for sequencing. Layer 1 (§2) is ratified coding semantics; Layer 2 (§3) is
design-target — its QB grain (one entry per allocation) is a working
assumption pending accountant confirmation (owner: "easy to roll up if
wrong").
**Owner:** reconciliation
**Companions:** [`workbench-business-rules.md`](workbench-business-rules.md)
(ratified workbench semantics — unchanged by this ADR except where noted),
[`reconciliation-design.md`](reconciliation-design.md) (two-plane link model —
retained), [`adr-source-link-ledger.md`](adr-source-link-ledger.md)
(implemented — retained).

## 1. Context

Production-data analysis (2026-07-23) of every many-to-many use of the money
model found that all genuine cases reduce to four real-world situations, each
of which already has exactly one canonical mechanism:

| Situation | Canonical mechanism |
| --- | --- |
| Bank deposit split into multiple QB records (e.g. Arthur Rock annual gift booked 1 QB record per allocation) | N `payment_applications` counted rows → 1 gift |
| One gift payment divided by meaning (fiscal year, entity, restriction, regrant) | `gift_allocations` |
| Multiple payments/deposits/gifts per pledge (incl. conditional/drawdown pledges such as Walton) | pledge → N gifts via `opportunity_id` |
| Multiple Stripe charges per Stripe payout/deposit | charge→payout (Stripe-side fact) + `settlement_links` (payout ↔ QB deposit) |

The two structures that go beyond these — `unit_groups` (pre-match grouping)
and gift-side partial application (one evidence unit counted toward several
gifts) — model nothing that the four mechanisms cannot. Every production
one-unit→N-gifts cluster (10 total, §6) is a miscoding under the ratified
rules below, not a modeling need.

## 2. Ratified coding rules (Layer 1 — buildable now)

1. **A gift/payment record is one real payment event.** One check/wire/charge
   = one gift. Two checks = two gifts (possibly two payments on one pledge,
   each its own gift). A payment event is never split into multiple gifts.
2. **All splitting of meaning happens on allocation rows** — fiscal year,
   entity, restriction (including Wildflower-designated), direct-to-school
   regrants. Never by multiplying gifts.
3. **Expectations live on the pledge, never as gifts.** Installment schedules
   are `pledge_expected_payments` rows; actual gifts supersede them. A
   prepayment covering several installments is ONE gift with allocations.
   (The route `routes/pledgeExpectedPayments.ts`, the installment editor
   `pledge-payment-plan.tsx`, and the match-scoring/revenue readers already
   exist — adoption is data entry and workflow convention, not a build-out.)
4. **Provenance is metadata, not gift structure.** Giving-fund /
   employee-withdrawal detail is `payment_intermediary` + memo on a single
   gift from the single real donor (Gates/Downey case).
5. **Evidence-side bundles are split evidence-side.** A QB/bank row that
   bundles several payment events is divided with split-units
   (`stagedPaymentSplitUnits.ts`, children sum to parent) — never by
   fractional gift-side application. The gift-side split-fraction match flow
   is retired.

### Schema consequences

- **`unit_groups` + `unit_group_members` are retired**, along with the legacy
  `staged_payments.source_group_id` column and its read shim
  (`unitGroupMembership.ts`). The workbench replaces group-then-match with
  multi-select match that writes N counted ledger rows atomically. Group
  outcomes already live entirely in the ledger; the only pre-match group in
  production (PELSB) is re-expressed by selecting its rows together.
- **Counted uniqueness:** after the §6 recoding, add a partial unique index —
  one `counted` `payment_applications` row per evidence anchor
  (`WHERE link_role = 'counted'`). `corroborating` rows are unconstrained.
- **`amount_applied` is retained.** Partial refunds legitimately reduce the
  applied amount below the unit's gross (`stripeRefund.ts`; invariant #7).
  Uniqueness constrains *which gift* a unit counts toward, not the amount.
- `payment_applications`, `settlement_links`, `source_links` (live since
  2026-07-21), header+allocations: all retained. No new tables.

## 3. Target end-state (Layer 2 — the linear tree)

Reconciliation becomes a tree rooted at the bank statement. Every node has
exactly one parent; splits happen only by subdividing a node into child
units; meaning splits happen only at allocations.

```
bank deposit
├─ (Stripe) → one Stripe payout → N charges → each: one gift → allocations
│                                  (Donorbox record corroborates the charge)
└─ (non-Stripe) → one gift or pledge payment → allocations
                  (multi-check/DAF deposits split into child units first;
                   each child → one gift)
```

### QuickBooks direction flip (forward-only)

- **Past (before cutover):** QB rows are matched evidence, exactly as today.
  The historical lens is frozen: it shows where Stripe payouts tie to QB and
  where they don't. History is never recoded to the new direction.
- **Forward (after cutover):** gifts/allocations are the coding authority.
  The system **generates a prescription list for the accountants** — one
  prescribed QB entry per allocation (working assumption; roll up later if
  the accountants prefer coarser grain). Humans key QB from the list; the
  system then *verifies* QB against the prescription instead of matching.
  **The pull-only invariant is preserved: the system still never writes to
  QuickBooks.**
- **Counted anchor migrates for non-Stripe money:** the bank deposit (or its
  child unit) becomes the counted evidence for check/wire gifts; QB rows
  become generated/corroborating documentation. For Stripe money the charge
  remains counted (gross; fees stay in `source_links` `charge_fee_row`).
- **Transition seam:** an explicit cutover point separates the frozen
  historical matched lens from the forward verification lens. The two never
  mix in one queue.

## 4. Miscoded-QB handling (unchanged by this ADR)

Miscoded QB evidence is a documentation-quality problem in the evidence
links; it never bends gift structure. Where the tie chain breaks tells you
the miscoding type; lens inventory as of 2026-07-23:

| Break | Lens today |
| --- | --- |
| Payout with no QB deposit | EXISTS — Settlement Report "Missing deposit" column; `settlement_gaps` cluster lens |
| Bank line with no payout/gift | EXISTS — unlinked-money / `needs_accounting` lenses |
| Standalone QB payment duplicating a Stripe charge | EXISTS — conflict lenses (`f_conflict`); resolution = corroborating tie, Stripe stays counted |
| QB deposit with no bank line | **MISSING** — add as a distinct lens (small; nearest is `crm_only`) |

`audit_ready` semantics unchanged: settlement link at deposit grain can hold
while line-level QB documentation is incomplete; unexplained rows stay
honestly unmatched.

## 5. Explicitly out of scope / unchanged

- Historical combined gifts (Walton drawdown 7 payments → 1 gift, Arthur Rock
  5 → 1) stay as-is; recoding them to gift-per-payment is optional and does
  not change the target schema. Going forward, drawdown/conditional pledges
  record one gift per payment event (rule 1).
- Donor XOR, archive-by-default, loan/revenue separation, refund semantics,
  the two-plane link model, and `source_links` are all unchanged.
- Per-employee soft credit (Downey-style stewardship attribution) is a
  possible future feature, deliberately NOT modeled as gift structure.

## 6. Production recoding inventory (human-gated)

The 10 one-unit→N-gifts clusters, to be recoded as reviewed, idempotent SQL
in `lib/db/migrations/` (evidence anchor ids from the 2026-07-23 analysis):

| Anchor (staged payment) | Today | Target |
| --- | --- | --- |
| `4Jn9XEMRrTWvBKKRiMU4f` Omidyar $1M | 2 gifts (FY20/FY21) | ~~1 gift, 2 FY allocations~~ **split-unit into 2×$500k children, one per gift** (deviation, ratified 2026-07-23: the two gifts sit on two *different* pledges — FY18–20 and FY21–23 — and `paid` is a gift-header rollup, so a single merged gift would corrupt one pledge's paid; a split is the truthful shape). Pledge expected payments backfilled on both pledges. |
| `4svk9IxogJIjkx65k097w` Omidyar $1M | 2 gifts (FY18/FY19) | 1 gift, 2 FY allocations; pledge expected payments backfilled |
| `57hcboHFPuX4qdljSM449` Kao $10k | 2 gifts share 1 QB row | split-unit into 2×$5k children, one per check gift |
| `AkvrooAk4pfsKl1lKWKvz` McKnight $25k | 2 identical $12.5k gifts | merge into 1 gift (entry artifact) |
| `WWbM-Xk_oxrSHO4zm6NT6` AOL fund $3.5k | Downey $875 + Gates $2,625 gifts | 1 gift, donor Gates, fund as payment intermediary, employee detail in memo |
| `a0BRZPHlxfgrW1Z0_sRis` LISC Q2 $8,578.61 | 2 gifts (GV + LISC CO) | 1 gift; GV regrant as direct-to-school allocation |
| `i9nY0GFAjF76PpdSAqbxS` LISC Q1 $7,712.50 | 2 gifts summing $7,712.00 | same pattern; the gift is corrected UP 50¢ to the money actually received (the GV allocation absorbs it) |
| `bllTXRZplXrsjM2VD7ws9` Nash $200k | 3 gifts (2 under Indira Foundation) | 1 gift under the household (the actual wire payer), **6 allocations** — the "3 allocations" here meant money buckets; the school-designation grain (Sundrops, Flame Lily, Lotus, Goldenrod) is preserved as-is |
| `jpy0gpkGm_1U-_RKbLcux` Sep Kamvar $478,660.14 | 3 gifts | 1 gift, **4 allocations** — Rising Tide consolidates ($126,436.14 + $200,000 = $326,436.14); the partnership passthrough, AZ gen-ops, and Northern-NJ gen-ops rows move intact (region grain preserved) |
| `y8JJig930lOjP9c9HN3uR` Frey $60k | 2 gifts (FY24/FY25 renewals) | 1 gift, 2 allocations, one Wildflower-restricted for FY26; one pledge with 2 expected payments |

## 7. Sequencing (minimizes drift; prod recoding is human-gated)

1. **This ADR + doc-drift fixes** (done in the same change as this file).
2. **Workbench multi-select match** writing N counted rows atomically — built
   *before* touching unit groups so there is never a window with no combine
   mechanism. Stops new group creation. **Done (2026-07-23):**
   `POST /quickbooks/staged-payments/multi-match` (open to all team members —
   CRM-side matching; errors: `selection_too_small`, `not_pending`,
   `not_groupable`, `multi_date_confirmation_required`, `amount_mismatch`,
   `link_conflict`, `link_invalid`); `POST /staged-payments/group` and
   `/group-reconcile` return 410 `group_creation_retired`; the workbench
   multi-select bar is now "Match to one gift", the clusters "Group QuickBooks
   records" action is removed, and legacy source-group cards re-link via
   multi-match with `confirmMultiDate`. Ungroup/eject remain for existing
   groups until step 3.
3. **`unit_groups` retirement**: reads, guards, `source_group_id` +
   `unitGroupMembership.ts`, group logic across ~13 server files
   (reconciliationGraph, reconciliationCommit, workbenchClusters, quickbooks
   actions/matching/shared, approve, cards, bundleAnchors, bundleProposals,
   giftsAndPayments, giftCombine 409 guards) and their tests. Also decide the
   multi-match edge case carried over from step 2: a selected member with a
   null/zero amount is stamped matched but books no counted row (mirrors the
   pre-existing single-row paths), so its derived status can stay pending —
   either reject zero-amount members at selection or book a zero row.
   **Done (2026-07-23):** every unit-group read and behavior is removed from
   the server, frontend, and OpenAPI contract — the multi-match coherence-key
   bypass (the last surviving read), workbench-cluster group envelopes
   (representative/member collapse, `isSourceGroup`, group note/member lists),
   whole-group revert fan-out, and ungroup/eject behavior are all gone; the
   group lifecycle endpoints (`/group`, `/group-reconcile`, `/ungroup`,
   `/:id/eject-from-group`) are 410 `group_creation_retired` tombstones, and
   plain per-row revert is the single undo path. The zero-amount edge case is
   resolved as reject-at-selection (`ZERO_AMOUNT` guard in multi-match). The
   `unit_groups` / `unit_group_members` schema definitions are kept, marked
   `@deprecated`, solely so existing prod rows survive for step 4's
   verification, which then drops both tables.
4. **Prod recoding** (§6) as reviewed idempotent migration SQL, applied by a
   human with `$PROD_DATABASE_URL`. **Written (2026-07-23), awaiting human
   apply:** `lib/db/migrations/0157_recode_counted_duplicate_units.sql`
   (runbook: `lib/db/migrations/0157_RUNBOOK.md`). Deviations from the §6
   table are recorded inline above. The `unit_groups` /
   `unit_group_members` table drop is deliberately NOT in 0157 — it ships as
   a separate later file once 0157 is verified in prod.
5. **Counted-uniqueness constraint LAST**, in a migration ordered strictly
   after the recoding file — never before, or the prod migration fails.
6. Layer 2 (bank-anchored counted role, prescription list, verification lens,
   missing "QB deposit with no bank line" lens) as a follow-on project once
   the accountants confirm the per-allocation grain.

Independent hygiene (any time): purge dev-DB test debris (stale test unit
groups/members/apps); backfill the 26 zero-allocation production gifts.
