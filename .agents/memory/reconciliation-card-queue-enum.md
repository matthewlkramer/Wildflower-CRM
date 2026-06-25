---
name: Reconciliation card queue enum
description: The /reconciliation/cards queue query-param has its OWN OpenAPI enum, separate from the shared staged-payment response-bucket enum; research is a filter, not a bucket.
---

# Reconciliation card queue enum

The `/reconciliation/cards` `queue` **query param** uses its own OpenAPI enum
`ReconciliationCardQueue`. The shared `QuickbooksStagedPaymentQueue` is the
**response** `queue` field type (the server-derived bucket) and ALSO doubles as
the `/staged-payments` query param + several response schemas.

`research` is a query-time FILTER, not a derived bucket: cards.ts maps
`queue=research` to `status='pending' AND needs_research=true`. `staged_payments`
has no `queue` column and the derived response bucket NEVER emits `research`
(it's orthogonal to the `needsResearch` boolean). So `research` belongs only on
`ReconciliationCardQueue`, never on `QuickbooksStagedPaymentQueue`.

**Why:** Adding a cards-only query value (like `research`) to the shared
`QuickbooksStagedPaymentQueue` is silent contract drift — it leaks into the
`/staged-payments` param (whose route normalizes unknown→needs_review, so the
filter silently no-ops) and into response schemas that can never emit it. The
server side never catches this: cards.ts parses `queue` as a loose `string` via
its own `reconciliationQueueWhere`, so the enum is purely the
generated-client/contract surface, not a runtime guard.

**How to apply:** When adding a new cards-only queue filter to
`/reconciliation/cards`, extend `ReconciliationCardQueue` (and handle it in
`reconciliationQueueWhere`), regenerate, and leave `QuickbooksStagedPaymentQueue`
alone unless the value is a real derived response bucket emitted for staged
payments.
