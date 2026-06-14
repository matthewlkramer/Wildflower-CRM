---
name: Email messages cross-mailbox dedup
description: Why email_messages has one row per mailbox per message, and how the list endpoint deduplicates them for display.
---

The `email_messages` table's unique key is `(mailboxUserId, gmailMessageId)` — the same
physical Gmail message is stored **once per synced staff mailbox**. This is intentional
(privacy isolation, per-user open tracking), but it means a donor in an email thread with
two sync-enabled staff users would see that email twice in their activity feed.

**Fix applied:** the `/email-messages` list query uses `DISTINCT ON (gmail_message_id)` as
a subquery, preferring the `sent` copy over `inbox` (richer outgoing-perspective metadata),
then re-orders by `sent_at DESC` in the outer query. `COUNT(*)` also runs against the
deduped set so the badge count is correct.

**Why:** keep one row per mailbox (existing schema) but deduplicate at read time.

**How to apply:** any new list endpoint or analytics query over `email_messages` that is
scoped to a person/org/household should apply the same DISTINCT ON dedup, or explicitly
acknowledge why duplicates are acceptable for that use case.
