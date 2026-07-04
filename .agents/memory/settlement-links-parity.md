---
name: settlement_links Plane-1 dual-write & parity gate
description: Non-obvious constraints when mirroring stripe_payouts recon state into settlement_links and gating the read-flip.
---

Phase-4 of the reconciliation redesign gives batch↔batch (Stripe payout ↔ QB
deposit) its own `settlement_links` table, additively dual-written from the legacy
`stripe_payouts.qb_reconciliation_status` + pointer columns via a single pure
mapping (`deriveSettlementLinkFields`) that the runtime dual-write, the 0089
backfill, and the parity gate ALL reuse. Two durable, non-obvious traps:

## confirmed_at drifts for non-human links — never compare it exactly there

`deriveSettlementLinkFields` sets `confirmedAt = COALESCE(qb_reconciliation_confirmed_at, updated_at)`.
The Stripe sync worker's payout upsert bumps `stripe_payouts.updated_at` on EVERY
re-pull **without** re-syncing the settlement link. So any link whose confirmedAt
came from the `updated_at` fallback (every `system_confirmed` link, plus any legacy
`human` row that has `confirmed_by` set but `confirmed_at` NULL) legitimately drifts.

**Rule:** the parity gate compares `confirmed_at` EXACTLY only when the derive read
the stable column — i.e. `provenance === 'human' AND qb_reconciliation_confirmed_at
IS NOT NULL`. Everywhere else it checks presence only (non-null for confirmed, null
for proposed). All load-bearing fields (lifecycle, provenance, deposit,
confirmed_by) are still compared strictly, so this does not open a false-PASS window.
`note` is also excluded (it holds the backfill's `legacy <status>` marker, not part
of the mirror).

**Why:** without the `qb_reconciliation_confirmed_at IS NOT NULL` guard the gate
false-FAILs on prod after any sync re-pull.

## deposit FK is ON DELETE SET NULL but a CHECK requires it — deletes error

`settlement_links.deposit_staged_payment_id` is `ON DELETE SET NULL`, yet
`settlement_links_deposit_required_chk` requires a non-`exempt` link to carry a
deposit. Postgres evaluates CHECKs during a referential SET NULL, so hard-deleting a
`staged_payments` row referenced by a `proposed`/`confirmed` link raises a CHECK
violation instead of nulling the pointer. Latent today (archive-not-delete; no
`delete(staged_payments)` path), but any future staged-payment wipe/delete tooling
must first clear or re-`exempt` the referencing links.

**How to apply:** dual-write coverage must hit ALL payout-recon write sites (grep
`update(stripePayouts)` + every writer of qbReconciliationStatus / the three pointer
cols — currently reconciliationCommit ×2, stripeConfirm ×7, stripeReconcile ×2); the
read-flip is gated on `parity:settlement-links` returning zero exceptions on **prod**
(dev parity ≠ prod), per the 0089 RUNBOOK.

## The parity gate is mirror↔deriver only — a read-flip can still shift derived semantics

`parity:settlement-links` proves `settlement_links` faithfully mirrors the legacy
status/pointer columns. It does **not** prove the flipped READS produce the same
derived output as the pre-flip reads. Those are different comparisons: the gate never
sees `derivePayoutLanes` / `deriveSettlementLinkFields` lane output.

Concrete case: the 0089 backfill maps ALL `confirmed_*` (via `LIKE 'confirmed_%'`),
**including `confirmed_excluded`**, to a `confirmed` link — `confirmed_excluded` IS a
confirmed settlement (the exclusion is a Plane-2 fact on
`staged_payments.exclusion_reason`, not a payout-settlement state; `exempt` is
reserved for links with no expected QB deposit). So after the read-flip a
`confirmed_excluded` payout's funding lane reads `confirmed`, where the pre-flip
legacy-status lane read `exempt`. The parity gate is blind to this; dev holds zero
`confirmed_excluded` rows.

**How to apply:** when flipping reads onto a mirror, don't trust the parity gate as
proof of read-equivalence. Diff the derived output on any status/edge the mirror maps
differently than the old read path, and read-only-check prod's population of those
edge statuses (here `confirmed_excluded`) before deprecating the legacy source.

## conflict_approved has no lifecycle value — it is `proposed` + `conflict_gift_id`

The 3-value lifecycle (proposed|confirmed|exempt) can't hold the legacy
`conflict_approved` state (a proposal that landed on an already-booked QB gift,
awaiting keep/replace). Representation: `settlement_links.conflict_gift_id`
(nullable FK→gifts_and_payments, ON DELETE SET NULL) mirroring
`stripe_payouts.qb_conflict_gift_id`. A conflict is `lifecycle='proposed' AND
conflict_gift_id IS NOT NULL` — deliberately NOT a 4th lifecycle value (that forks
every lifecycle read, e.g. `derivePayoutLanes` maps lifecycle straight to funding).

**Rule:** the deriver emits `conflictGiftId = payout.qbConflictGiftId` unconditionally
for BOTH proposed AND confirmed families (retained on the confirmed link as the
revert-of-keep discriminator + double-book-guard input). Parity compares it with
`(a ?? null) !== (b ?? null)` — no drift carve-out (unlike confirmed_at, it has no
sync-worker bump source).

**Why the mirror must NOT add its own re-pointing:** the propose pass
(`stripeReconcile`) sets/clears `qbConflictGiftId` atomically with status in the SAME
`update(stripePayouts)` then calls the sync — so `proposed` can never carry a stale
conflict pointer. Gift merge does NOT re-point `qbConflictGiftId` (losers are
archived, not deleted), and gift hard-delete nulls both columns symmetrically via
ON DELETE SET NULL. So mirror==derive(payout) holds by construction; adding divergent
merge re-pointing to `conflict_gift_id` alone would break parity. Any future
AUTHORITATIVE writer (post write-flip) MUST preserve this atomic set/clear of the
conflict pointer alongside lifecycle. Backfill 0092 can only SET (column starts all
NULL); the never-CLEAR case is unreachable at backfill time and the gate catches it.

## Write-flip needs NO parity-direction flip — reverse map is the exact inverse

The Phase-4 write-flip inverts authority ONE write path at a time (the Stripe
proposal pass first): the caller expresses settlement INTENT as the
`settlement_links` row it wants, and a pure `reverseSettlementLink(link|null)`
reverse-derives the legacy `qb_reconciliation_status` + pointer columns FROM it
(`settlementWriter.ts`). The forward parity gate (`derive(legacy) == link`) STAYS
valid with NO direction flip — but ONLY because `reverseSettlementLink` is the EXACT
inverse of `deriveSettlementLinkFields` over the ONLY four states an authoritative
writer can produce: {unmatched, proposed, conflict_approved, confirmed_reconciled}.
The two are lockstep by construction, so the reverse-mapped legacy columns are
byte-identical to what the old inline `.set()` wrote.

**Rules that keep this safe:**
- `reverse` writes `confirmed_at` FROM the link (not COALESCE-to-updated_at), which
  kills the drift carve-out for rows the writer creates. So a confirmed link MUST
  always carry a non-null `confirmedAt` or it fails to round-trip (derive coalesces
  null → updated_at). `stripeConfirm` always stamps it — add an explicit round-trip
  test when the confirm family flips (T4).
- `reverse` on lifecycle `exempt` THROWS: no writer produces exempt today (the
  deriver never returns it; `confirmed_excluded` backfills to `confirmed`). If a
  future intent introduces exemptions, map it explicitly then.
- The legacy mirror (`syncSettlementLinkFromPayout`, still used by the not-yet-
  flipped confirm/commit paths) and the authoritative path MUST share the SAME
  physical `upsertSettlementLink`/`deleteSettlementLink` so the row shape can never
  drift between callers.
- Money-safety guards on the `update(stripePayouts)` (REPROPOSABLE status WHERE +
  candidateStateGuard) are UNCHANGED by the flip — the flip only changes how the
  `.set()` payload is COMPUTED, never the guarded primitive. `reverse(null)` also
  nulls matched/confirmed* cols, but those are already null in every REPROPOSABLE
  state (matched/confirmed* are written only at confirm, nulled in every revert), so
  it is a faithful no-op.

**T5 read-flip caveat:** the old mirror re-read post-write payout state, so a human
confirm racing between the propose UPDATE and the link write got mirrored as
confirmed; the new path upserts the precomputed *proposed* link, leaving a transient
proposed link on a just-confirmed payout until the confirm's own sync / next pass
converges it. Harmless while legacy columns are the read source (parity would flag
it) — re-examine when readers flip to the link in T5.
