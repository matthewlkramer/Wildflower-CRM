---
name: Reconciliation search bands & confirm gating
description: Two rules from prod bugs — criteria-search amount bands must not AND with text, and routes must not pre-gate on derived status ahead of a locking primitive.
---

## Rule 1: text overrides the amount band in criteria searches

In the reconciliation criteria searches (`searchQbStagedRows`, `searchStripeChargeRows`,
`searchPayouts` in `reconciliationGraph.ts`), the amount proximity band (±20%/±$50 or
the fee band) hard-filters **only when there is no text criterion** (`hasAmount && !hasText`).
With text, the amount only RANKS (orderBy).

**Why:** The UI always passes the anchor amount alongside typed text. A payout booked
as several small per-donor QB rows has no row anywhere near the payout net, so an
ANDed band silently hid the very rows an explicit name search asked for (prod bug:
a charge's payer name found nothing).

**How to apply:** Any new criteria search with both a text and an amount input must
follow the same rule. Also: payouts have no name of their own — text search must
reach through to the charges' payer fields (EXISTS over stripe_staged_charges).

## Rule 2: never pre-gate on derived status ahead of a locking confirm primitive

The settlement resolve-confirm route once rejected any picked deposit whose derived
status != `pending` with a transient "refresh and retry" 409. But
`confirmPendingQbDepositInTx` re-derives status under the same FOR UPDATE lock and
handles every arm safely (pending → full confirm; match_confirmed not settled
elsewhere → linkage-only confirm + supersede demote so money is never double-counted;
excluded/match_proposed → permanent `deposit_unconfirmable`).

**Why:** The pre-gate duplicated the primitive's logic with a stricter rule and
blocked the legitimate repair path (deposit booked BEFORE its payout tie exists),
surfacing a misleading transient error for a permanent-looking state (prod bug).

**How to apply:** When a route wraps a transition primitive that derives state under
lock, let the primitive be the single authority on eligible states; the route only
adds gates the primitive genuinely doesn't know about (lump eligibility, grouping,
exclusivity). Also mirror the primitive's result kind in the response — don't
hard-code one (`confirmed_linkage_only` vs `confirmed_reconciled`).

## Rule 3: only the EXCLUSION blocker is user-overridable in pick dialogs

Blocked pick-list rows carry a machine-readable `conflictKind`
(`excluded` / `settled_elsewhere` / `tied_to_charge`) alongside the human
`conflictReason`. Only `excluded` is click-to-override (two-click arm in the UI,
`overrideExclusion` on the confirm body); the server re-includes the row **in the
same transaction** as the tie (clear `exclusion_reason` + pin
`classification_source='manual'` so the re-runnable classifier never re-excludes),
guarded by the derived-excluded predicate under the existing FOR UPDATE lock.

**Why:** An exclusion is a classifier *opinion*, safely reversible (same semantics
as the standalone re-include primitive). Settled/tied-elsewhere blockers are
*claimed money* — overriding them would double-count. Amount-mismatch charge ties
also stay hard-blocked (assignment is exact-amount). System-proposed (mode A)
charge-tie confirms intentionally ignore the flag — overrides must be explicit
manual picks.

**How to apply:** A new blocker kind in a pick dialog must decide which side it is
on: reversible classification (overridable, re-include in-tx with a manual pin) vs
claimed money (hard 409, flag inert — and test that the flag IS inert there).
