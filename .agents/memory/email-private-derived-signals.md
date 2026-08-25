---
name: Private email derived signals
description: Privacy rule for cross-mailbox email queues, aggregates, and inferred status.
---

Cross-mailbox review must apply source-email visibility before deriving any
status, count, or existence signal. A private message cannot affect a visible
`hasReply`, count, timestamp, or badge for a reviewer who cannot open that
message.

**Why:** Filtering private rows from a table is insufficient if a correlated
subquery or aggregate still reveals that a hidden message exists.

**How to apply:** For every all-mailboxes email query, apply the same
owner-or-non-private predicate inside reply detection, counts, maxima, and other
derived fields—not only on the outer row set.