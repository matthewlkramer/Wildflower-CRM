---
name: QB donor matching only runs at ingest; rematch backfill is the remedy
description: Why the "QBO only" review queue fills with donor-less rows that obviously match, and the safe admin backfill that fixes it.
---

# QuickBooks donor re-matching is ingest-time only

Donor auto-matching (`scoreStagedPayment`) runs **only** at ingest, inside
`syncQuickbooks`. The 30-min scheduler (`quickbooksSyncScheduler.ts`) calls only
`syncQuickbooks` — it never re-scores the back-catalog.

**Consequence (the recurring symptom):** a staged payment pulled *before* its CRM
donor existed (or before that donor was created/renamed) stays donor-less in the
"QBO only" / needs-review queue **forever**, even once an exact-name match now
exists. Users report "payments that should obviously be matched aren't" / "I
thought these were already matched."

**Remedy:** `rematchStagedPayments()` in `quickbooksSync.ts` — an on-demand,
admin-only backfill exposed at `POST /quickbooks/rematch` (`requireAdmin`,
generated hook `useRematchStagedPayments`), wired into the Reconciliation
Workbench header behind `useIsAdmin` ("Re-match donors" button).

**Why it's safe to run freely:**
- DONOR-ONLY. It sets donor FK(s) + match status/score/method/intermediary; it
  **never** sets `matchedGiftId`, mints, or reconciles a gift. (Auto-apply/mint
  only happens on fresh ingestion.) So a bulk re-match can never write the ledger.
- Advisory-locked under the shared QB key (`ran:false` when a sync/rematch is
  already running).
- Each write is a guarded conditional UPDATE requiring `status='pending'`,
  donor-less (all 3 FKs NULL), AND `matchStatus IN ('unmatched','suggested')` — so
  a concurrent human resolve is never clobbered.

**Scope gotcha:** it must scan donor-less rows whose match is `unmatched` **OR**
`suggested`. An `unmatched`-only filter silently skips historical rows that once
surfaced a weak hint (status `suggested`) but never persisted a donor FK — exactly
the easy matches that look "stuck."

**How to apply:** when someone reports the QBO-only queue is full of
should-be-matched rows, reach for the rematch backfill (or tell them to click
"Re-match donors"); don't re-derive the root cause or add a scheduler re-score.
A high-tier exact hit sets `matchStatus='matched'` + donor FK (no gift link), so
the card moves QBO-only → Needs review via the proposed donor; it is not mistaken
for reconciled.
