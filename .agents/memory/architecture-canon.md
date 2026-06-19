---
name: Canonical architecture docs
description: Where the authoritative app map + design invariants live; read before non-trivial changes.
---

# Canonical architecture & intent docs

The authoritative, kept-current description of *what this app is and what we're trying
to do* lives in two files — read them first for any non-trivial change:

- `replit.md` — product goal, the 7 **Design principles** (contract-first; header +
  allocation money model; calculated opportunity status; Donor XOR; revenue vs loan
  capital as parallel tracks; archive-don't-delete; non-destructive human-applied prod
  data) and a per-feature subsystem rundown (incl. QuickBooks, Stripe + Stripe↔QB
  reconciliation, revenue coding, email/calendar sync + intelligence, grant leads,
  tasks, entity merge).
- `lib/db/SCHEMA.md` — per-table reference + cross-table invariants. The Drizzle code
  in `lib/db/src/schema/*.ts` (+ `_enums.ts`) is the ultimate source of truth.

**Why:** both are kept current as the single orientation map so future work stays
consistent instead of re-deriving intent. The dozens of other topic files in this
memory dir are the *non-obvious lessons underneath* those docs — they complement, not
replace, the canon.

**How to apply:** start from replit.md + SCHEMA.md for orientation; use memory topic
files for the gotchas; trust the schema code over any prose if they ever disagree.
