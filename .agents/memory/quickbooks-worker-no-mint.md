---
name: QB sync worker never mints (auto-create is rule-only)
description: The QuickBooks sync worker auto-applies ONLY by reconciling to a single existing gift; brand-new gift auto-creation is reserved for explicit admin handling rules.
---

# QuickBooks sync worker: no generic auto-mint

**Rule:** The off-hours QB sync worker's `autoApply` (quickbooksSync.ts) only ever
RECONCILES a staged payment to a single existing gift (`scored.matchedGiftId`).
It must NEVER mint a brand-new gift. When a high-confidence donor match has zero
(or several ambiguous) candidate gifts, the row stays `pending` in the
needs-review queue with its donor hint, for a human to create or match.

Auto-creating a gift without a human is reserved for explicit admin handling
rules (`auto_create_approve`, e.g. `seed_amazonsmile` → GenOps), which are
evaluated at INGEST in the runSync loop BEFORE the matcher and `continue` past
`autoApply`. So disabling the worker mint does not affect Amazon Smile.

**Why:** The old `giftCandidateCount === 0 → MINT` branch, when driven across a
full QB back-catalogue re-pull, auto-created 153 unreviewed gifts (~$10.27M),
mostly duplicates of gifts already in the CRM plus large foundation grants
(Spring Point $1M, Walton, Valhalla $500k, …). The product owner wants ONLY
Amazon Smile micro-deposits to auto-create; everything else must be human-reviewed.

**How to apply:** Do not reintroduce a worker mint path. New "auto-create without
review" categories must be added as `auto_create_approve` handling rules (admin UI
/ seed rules), never as code branches in the matcher/worker. Besides single-gift
reconcile (non-minting), the only sanctioned minters are the rule paths
(`applyAutoCreateRule` / `applyAutoCreateRuleToRow`) and the human approve route
in `routes/quickbooks.ts`.

**Worker-mint marker** (for any future cleanup): `details LIKE 'Imported from
QuickBooks (%'` AND `owner_user_id IS NULL` AND `legacy_gift_id IS NULL` AND
`created_at_from_airtable IS NULL`. Amazon Smile is distinguished by
`name ~* 'amazon\s*smil'`. Cleanup ships as a reviewed idempotent SQL applied to
prod by a human (the agent cannot write prod).
