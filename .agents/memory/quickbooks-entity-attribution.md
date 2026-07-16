---
name: Entity attribution (replaced fiscally_sponsored exclusion)
description: The fiscally_sponsored staged-payment EXCLUSION was retired in favour of attributing money to its Wildflower entity and keeping it in the review queue.
---

**SUPERSEDED MODEL — read this before touching fiscally_sponsored.** The QB
staged-payment classifier used to EXCLUDE money belonging to a fiscally sponsored
project (first instance: "Embracing Equity") via the `fiscally_sponsored`
exclusion reason (a project-IDENTITY rule that ran before the donation-first
guard). That behaviour was **removed** during the "Finance Reconciliation"
rebrand.

**Current model:** fiscally sponsored money is no longer hidden. Instead it is
**attributed** to its entity and **kept in the review queue** for a fundraiser to
reconcile:

- A pure `detectEntity(input)` + `ENTITY_MARKERS` (declaration-ordered, first
  match wins, case-insensitive substring) sets `staged_payments.entity_id`. This
  is SEPARATE from exclusion — `classifyStagedPayment` no longer returns
  `fiscally_sponsored`. The `fiscally_sponsored` enum VALUE is retained only for
  historical rows (non-destructive); nothing produces it anymore.
- `detectEntity` scans the same fields as `allTextFields` (payerName,
  rawReference, lineDescription, lineClasses[], lineItemNames[],
  lineAccountNames[]) — NOT qb_transaction_memo.
- **"sunlight" is intentionally OMITTED from ENTITY_MARKERS.** `sunlight_debt`
  and `sunlight_grants` are one entity split across two rows (debt vs revenue); a
  bare "sunlight" marker can't disambiguate, so those rows stay unattributed
  (Wildflower Foundation is the default/null bucket) for manual filing.

**Lockstep still applies:** `ENTITY_MARKERS` (TS) and the entity-backfill SQL
must stay in sync — the SQL mirror concatenates the same columns with a `\n`
separator (no multi-word marker contains `\n`, so a marker can't falsely span two
array elements) and matches each marker `ILIKE '%marker%'` in declaration order.
The persisted `seed_fiscally_sponsored` handling rule is DISABLED (not deleted)
so runtime `evaluateRules` stops excluding; data migration also re-surfaces rows
the system auto-excluded as fiscally_sponsored (excluded→pending, reason→null,
`classification_source='auto'` only) and seeds/activates the entity rows.

**How to add another attributed entity:** add its distinctive name to
`ENTITY_MARKERS` AND the matching `WHEN ... ILIKE` clause to the entity-backfill
SQL, AND ensure the `entities` row exists + is active. Approved historical rows
are not reclassified by a backfill (touches `pending`); correct them per-row in
the app.

**Fiscally-sponsored REVIEW QUEUE (distinct from the retired exclusion).** A
later request parked the noisy sponsored-entity money in its own queue instead of
the default needs-review one — code-only, NO data migration (entity_id is already
attributed). `FISCALLY_SPONSORED_ENTITY_IDS` (in `routes/quickbooks/shared.ts`) is
a SHORT parking list (currently embracing_equity, tierra_indigena) — deliberately
NOT all of ENTITY_MARKERS. The split lives in `queueWhere`/`queueExpr`: the new
`fiscally_sponsored` queue = pending AND entity in the parking list; `needs_review`
= pending AND (entity_id IS NULL OR NOT in list). **Why the NULL guard:**
`entity_id NOT IN (...)` is NULL-unsafe, so the Foundation default (NULL) would
silently drop out of needs_review without the explicit `IS NULL OR` branch.
**How to apply:** the new queue is FULLY actionable (same reconcile/match/exclude
actions as needs_review) — the frontend gates these on `isPendingQueue =
needs_review || fiscally_sponsored`. **Contract gotcha (the real trap):** the
queue enum AND the summary schema are SHARED by BOTH the QuickBooks and the Stripe
staged-charge endpoints. Do NOT widen the shared `StagedPaymentQueue` /
`StagedPaymentSummary` for a QB-only need — it silently changes the Stripe
contract (a required field Stripe never returns; an enum value Stripe never
emits). Instead QB gets its OWN variants: `QuickbooksStagedPaymentQueue` (superset
enum) and `QuickbooksStagedPaymentSummary` (`allOf` StagedPaymentSummary +
required fiscallySponsored); Stripe keeps the pristine base schemas, and
`routes/stripe.ts` is already fully decoupled (its own private Queue/queueWhere).
Use `inArray` for the predicate, never `ANY(...::text[])` (runtime record-cast
failure). Parking another entity = add its slug to `FISCALLY_SPONSORED_ENTITY_IDS`
only (no markers/SQL/migration needed).

**Parking applies to BOTH main flows.** There are TWO queues: the legacy
`/quickbooks/queue` (parks via `queueWhere`) AND the newer reconciliation CARDS
flow (`reconciliation/cards.ts`, `reconciliationQueueWhere`). The cards DEFAULT
("all"/live work) must ALSO exclude pending fiscally-sponsored rows — it's a
separate `sql` template, so it does NOT inherit `queueWhere`'s split. Mirror the
needs_review guard inline: `status='pending' AND (entity_id IS NULL OR NOT
(${isFiscallySponsoredRow}))` on the pending branch ONLY (leave the
approved-with-Stripe branch untouched). `isFiscallySponsoredRow` is exported from
`quickbooks/shared.ts` for this reuse. `queue=fiscally_sponsored` already views
the parked queue on cards (falls through to `queueWhere`); the frontend worklist
(`reconciliation-qb-worklist.tsx`) exposes it as a "Fiscally sponsored" sub-filter
(still fully matchable). **Why:** the cards default was missed when the legacy
split was first added, so sponsored money still cluttered the new main flow.

**Manual entity override (entity_source):** entity attribution can be pinned by a
human. A separate `staged_payments.entity_source` enum ('auto'|'manual') —
mirroring `classification_source` but ORTHOGONAL to it — guards the override: a
'manual' row's `entity_id` is never re-touched by `detectEntity` (honoured in BOTH
the re-pull upsert and `reclassifyStagedPayments`).
**Why:** "Sunlight" money (omitted from ENTITY_MARKERS) must stay un-attributed
across syncs, and broad-substring misattributions need a durable human correction.
**How to apply:** clearing the entity to NULL still pins manual — that is exactly
how a row is kept un-attributed without re-sync re-attributing it. Any new code
path that writes entity_id from detectEntity must first check entity_source.
