---
name: Coding-form gift matching
description: Guardrails for coding-form row → gift matching, candidate surfacing, and bulk rematch.
---

# Coding-form gift matching

- Rematching a row **clears its donor + confirmation fields**. Any bulk rematch path
  must filter to `status='pending' AND match_confirmed_at IS NULL` so it can never
  touch a human-confirmed/applied/skipped row.
  **Why:** every human edit via the match PATCH stamps `matchConfirmedAt` +
  `matchMethod='manual'`; a rematch over such a row would silently undo a person's decision.
  **How to apply:** keep the WHERE guard on any new bulk/scheduled rematch entry point;
  don't rely on the per-row helper to be safe on its own.
- Amount matching has two distinct bands: the ingest scorer keeps its fee-tolerant band,
  while coding-sheet matching uses an **exact** (±1¢) band, because the sheet transcribes
  the booked gift amount itself. Don't merge the two; the band is a parameter of the one
  shared bounds helper, not a second predicate.
- Auto-propose a gift only when **exactly one** exact candidate exists; with 2+ candidates,
  surface a live (never persisted) candidate list gated to
  `pending && matchedGiftId null && matchConfirmedAt null` and let the human pick —
  consistent with the user's "show, don't guess" preference.
