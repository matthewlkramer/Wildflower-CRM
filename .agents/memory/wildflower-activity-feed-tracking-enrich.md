---
name: Activity-feed email open-tracking enrichment
description: How tracked-email open status is merged onto synced Gmail rows in the contact activity feed.
---

The contact detail activity feed renders email items from synced Gmail
`email_messages`, NOT from `tracked_emails` (the open-pixel table). To show open
status per contact, the `GET /email-messages` route enriches each row server-side
with `isTracked` / `trackingTotalViews` / `trackingLastOpenedAt` (computed, not
columns) and the frontend renders an "Opened N×" / "Not opened yet" badge.

**Why a merge (not a separate feed source):** user explicitly wanted the tracked
status ON the existing email items, not a second card. Accepted tradeoff: a sent
email shows in the feed only AFTER Gmail sync imports it into `email_messages`
(≤15 min business hours) — a brand-new send is in `tracked_emails` immediately but
not in the feed until synced.

**Matching rule (`matchSentEmailTracking`, pure, unit-tested):** a synced SENT
row matches tracked rows by EITHER exact `gmail_message_id` OR fuzzy
(lowercased sender == fromEmail AND lowercased subject == subject AND within
`TRACKING_MATCH_WINDOW_MS` = 2h). **Exact id is authoritative:** if any exact
gmail-id match exists, only exact rows are aggregated — fuzzy is fallback-only so a
same-subject legacy row can't inflate an exactly-matched send.

**Scope combiner is OR, not AND** (unlike the email-messages list WHERE). A tracked
email is xor-linked to one donor type, so AND-combining person/funder/household
predicates would match nothing. The feed only ever passes one scope dim anyway.

Files: `artifacts/api-server/src/lib/emailTrackingEnrich.ts` (matcher +
`computeTracking`), wired into `routes/emailMessages.ts` list handler.
