---
name: Coding-form gift matching
description: Guardrails for coding-form row → gift matching, candidate surfacing, and bulk rematch.
---

# Coding-form gift matching

- Rematching a row **clears its donor + confirmation fields**. Any bulk rematch path
  must filter to `status='pending' AND match_confirmed_at IS NULL` — and pass the
  rematch helper's `onlyIfUnconfirmed` option so the guard is **row-atomic in the
  UPDATE itself**, not just in the up-front snapshot (a concurrent admin can confirm
  mid-pass; the long bulk pass would otherwise clobber it).
  **Why:** every human edit via the match PATCH stamps `matchConfirmedAt` +
  `matchMethod='manual'`; a rematch over such a row would silently undo a person's decision.
  **How to apply:** keep both the snapshot WHERE guard and `onlyIfUnconfirmed: true`
  on any new bulk/scheduled rematch entry point. The explicit per-row rematch route
  deliberately omits the option — a user re-matching a confirmed row is intentional.
- Link approval is a **separate lifecycle from row status**: confirm endpoints
  (per-row + bulk "confirm all matched") stamp ONLY `matchConfirmedAt`/`byUserId`,
  never rewriting the proposal or its `matchMethod`/`matchTier` auto provenance
  (unlike the match PATCH, which re-stamps manual/high). Bulk confirm requires
  pending + unconfirmed + donor + matched gift; per-row 409s without a donor.
  Confirming freezes the row out of all future bulk rematch passes; `status`
  (pending/applied/skipped) stays about coding-data apply, not the link.
- Amount matching has two distinct bands: the ingest scorer keeps its fee-tolerant band,
  while coding-sheet matching uses an **exact** (±1¢) band, because the sheet transcribes
  the booked gift amount itself. Don't merge the two; the band is a parameter of the one
  shared bounds helper, not a second predicate.
- Auto-propose a gift only when **exactly one** exact candidate exists; with 2+ candidates,
  surface a live (never persisted) candidate list gated to
  `pending && matchedGiftId null && matchConfirmedAt null` and let the human pick —
  consistent with the user's "show, don't guess" preference.
- Cross-checks carry `willWrite`/`willWriteTo` preview fields (exact value + destination
  record/field, create vs overwrite) shown before the Apply checkbox.
  **Why:** the reviewer couldn't tell what Apply would change; sheet/CRM columns alone
  don't line fields up. **How to apply:** any change to the apply logic (new attribute,
  different target, changed write semantics) MUST update the matching preview in the
  cross-check builder in lockstep — the preview is computed beside, not derived from,
  the apply code, so drift is silent. Preview is populated only when apply is actionable
  (applicable, unblocked, status new/conflict); null means Apply is a no-op.
