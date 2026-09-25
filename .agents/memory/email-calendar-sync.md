---
name: Email & calendar sync
description: Grouped index of email/calendar-sync lessons — Gmail/Calendar sync & storage, open tracking, email intelligence (AI proposals), Flodesk, and email-address data.
---

## Gmail/Calendar sync & storage

- [email-messages cross-mailbox dedup](email-messages-cross-mailbox-dedup.md) — same Gmail message stored once per mailbox; list endpoint uses DISTINCT ON (gmail_message_id) to deduplicate.
- [wildflower email/calendar HTML entities](wildflower-html-entities.md) — Gmail/Calendar/Airtable text is HTML-escaped; decode at render via decodeHtmlEntities, not user-authored content.
- [internal email domains config](internal-email-domains-config.md) — staff domains moved from hardcoded Set to internal_email_domains singleton; matcher loads via cached loadInternalDomains; defaults seed/fallback keep sync unchanged on rollout.
- [Gmail sync stall detection](gmail-sync-stuck-detection.md) — email_sync_state.no_progress_runs counts consecutive errored runs (cursor held); reset on clean run; admin panel flags >= threshold as stuck.
- [Staff-default sync suppression](staff-default-sync-suppression.md) — internal-email person w/o a window is permanently suppressed (a window overrides); every email-ownership write must bust the cached staff set.

## Open tracking

- [Activity-feed email open-tracking enrich](wildflower-activity-feed-tracking-enrich.md) — tracked open status merged onto synced email_messages server-side; exact gmail-id beats fuzzy; shows only after sync.
- [Per-recipient open tracking (Path A)](wildflower-per-recipient-tracking.md) — multi-recipient server-send guardrails (Bcc/attachment/reply fallback, region-scoped chip extraction, extension-token auth, gmail.send reconnect).
- [Private email derived signals](email-private-derived-signals.md) — cross-mailbox views must exclude private messages from booleans/counts as well as rows; otherwise aggregates disclose existence.

## Email intelligence (AI proposals)

- Signature-update proposals accept only the most recent 24 months of source
  mail. After AI drafting, `emailIntelActionValidation.ts` is the deterministic
  authority that removes duplicate/no-op contact changes, evidence predating a
  past-role update, and mailbox-owner phones/roles before actions are stored.
  Apply-time dedupe remains the final safety net, not the review-queue filter.
- New-correspondent discovery combines retained mail with owner-only
  `email_sync_skip` headers; count distinct messages, not invented historical
  threads. Reply-address proposals require same-mailbox outbound thread
  evidence plus an unambiguous full sender name. See `docs/email-intelligence.md`.
- Meeting absence lives in `calendar_event_attendance` using the shared physical
  event key; never write attendance into Google's `attendee_emails` array.

- [AI proposal call resilience](wildflower-ai-proposal-resilience.md) — per-proposal Anthropic call must use withRateLimitRetry + shared aiProposalLimit; SDK maxRetries:0; sweep retry phase drains error backlog w/o 24h cooldown.
- [email-intel AI failure recovery](email-intel-failure-recovery.md) — errored-pending self-heal via analyzePendingForUser retry (cooldown-gated under per-user gmail lock; manual retry resets actionsError+actionsAnalyzedAt); BUT pending+analyzed_at NULL+no-error has NO auto path — only manual owner /retry unsticks ([stuck-analyzing](email-intel-stuck-analyzing.md)).
- [email-intel propose-alternative + note append](email-intel-propose-alternative.md) — reviewer guidance re-runs AI in place (stays pending); accept/reject/revise all APPEND to reviewerNote, never overwrite (prompt-tuning signal).
- [Thank-you detector donor coverage](thank-you-detector-donor-coverage.md) — links gifts for org/individual/household; households have no proposal target col (payload only); accept is donor-agnostic.

## Flodesk

- [Flodesk subscriber + MCP evidence sync](flodesk-subscriber-sync.md) — people→one segment; Basic auth (not Bearer)+User-Agent; official MCP recipient analytics; inbound monotonic, Flodesk unsubscribe wins; daily-then-weekly campaign cadence; advisory lock (9001,2).

## Email-address data

- [emails global uniqueness](emails-global-unique.md) — one address per emails row anywhere; unique index on lower(email)+API 409; dedupe must repoint email_proposals.target_email_id (ON DELETE SET NULL) before delete; run file before Publish.
