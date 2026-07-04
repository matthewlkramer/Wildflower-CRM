---
name: Reconciliation redesign phase status source
description: Where to read the TRUE phase status of the reconciliation redesign (migration ledger + schema header comments, not the design-doc prose)
---

The authoritative phase status of the reconciliation redesign
(`docs/reconciliation-design.md`) is the **migration sequence + the schema header
comments**, NOT the doc's §7 "Progress / holdout / blocking" annotations — those
lag the code.

**Why:** §7's progress notes were written mid-flight and were not re-updated as
later phases shipped. Reading them at face value led to reporting already-shipped
phases (the QB/Stripe/Donorbox ledger read-flips, the `settlement_links` write-flip,
the `gift_evidence_links` drop) as still in-flight / prod-gated when they were done.

**How to apply:** To answer "what reconciliation phase are we on," read the newest
migrations and the schema header comments, not the doc prose:
- `payment_applications` backfill + link_role/lifecycle prep, `unit_groups`,
  `settlement_links` (+ conflict_gift_id move), and the DROPs of `gift_evidence_links`
  and the `stripe_payouts` recon-status mirror are the real signal.
- Header comments in `lib/db/src/schema/settlementLinks.ts` and
  `paymentApplications.ts` state which plane/phase is authoritative.
As of mid-2026: the unit↔gift ledger plane and the Plane-1 `settlement_links` plane
have shipped (read-flips + the legacy 7-value enum / pointer / `gift_evidence_links`
drops). `giftPaymentSummary` still reads processor **fees** from the Stripe/Donorbox
tables **by design** (fees are not modelled in the ledger) — not an unfinished
holdout. What remained: the two-report UI collapse (design "Phase 6", never built —
its planning task was archived minutes after creation) and the deprecate-then-drop
tail (`staged_payments.source_group_id`, dead enum values).

**Drop-readiness caution (verify, don't trust the label):** a schema `@deprecated`
comment is NOT proof a column is drop-ready. Several `gifts_and_payments` columns
labelled `@deprecated` "no longer read or written" are in fact STILL read/written by
live code — `quickbooks_tie_status` (feeds `deriveGiftLanes` + the gifts filter,
recomputed by `applyGiftQbTieMany` on every gift mutation), `final_amount_source`
and the `final_amount_*` provenance pointers (QB matching/actions still write them,
financial corrections read them), and `type` (still read by the gifts list filter,
analytics, revenueCoding, gatherTaskSignals; copied onto split-gift rows). ALSO
still live: `grant_year`, `designated_to_school`, `off_books_fiscal_sponsor`,
`payment_expected` — `giftIsOffBooksExpr()` (giftPaymentSummary.ts) still OR's the
three header flags into the off-books / QB-tie exemption as a DOCUMENTED
transitional fallback until a prod backfill migrates them to allocation entities,
and the split-gift path copies grant_year/designated_to_school/payment_expected
onto new rows. The ONLY genuinely-retired `gifts_and_payments` column is
`processor_fee` (derivedProcessorFee replaces it). Because those flags are live,
the OpenAPI descriptions for off_books_fiscal_sponsor / payment_expected are
ACCURATE — do NOT "fix" them. `staged_payment_splits` is likewise fully live (QB
split resolution). All the false schema comments (quickbooks_tie_status,
final_amount_*, type, grant_year, designated_to_school, off_books_fiscal_sponsor,
payment_expected) were corrected in-place to "TRANSITIONAL … STILL LIVE" in 2026-07.
Two traps hid the live readers on the first pass: `rg … | head -N` truncated the
route hits, and `payment_expected` is read as raw SQL (`g.payment_expected`), not
the camelCase drizzle property, so a `-w paymentExpected` grep missed it. Always
grep live readers/writers WITHOUT a `head` cap (and check raw-SQL snake_case) before
treating any `@deprecated` column/table as droppable. As of 2026-07 the one
clean reconciliation drop candidate is `staged_payments.source_group_id`: no live
route code touches it (only parity scripts) and a read-only PROD parity run against
`unit_groups` (0088 backfill) was perfectly clean (0 missing/mismatch/orphan).
