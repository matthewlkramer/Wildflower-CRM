---
name: QuickBooks staged-payment "link to existing gift"
description: Why staged_payments.created_gift_id is overloaded for created-vs-linked, and the no-DB-constraint double-link guard.
---

The staged-payments review queue supports two resolutions: "Approve → create
gift" (mints a new gifts_and_payments row) and "Link to existing gift" (ties the
QB record to an already-recorded gift, no new row).

- **created_gift_id is overloaded** — both flows set `staged_payments.created_gift_id`
  to the resulting gift; "linked" reuses the same FK as "created".
  **Why:** chosen to avoid a prod schema migration (user prefers non-destructive
  changes; agent can't write prod). There is no DB-level flag distinguishing
  created vs linked. If you ever need to tell them apart, add a column via the
  staged SQL-file flow, don't infer.

- **One gift ↔ one staged payment is enforced in app code, not the DB.** There is
  no unique index on `created_gift_id`. The link endpoint guards double-counting
  with an atomic conditional UPDATE: `WHERE id=:id AND status='pending' AND NOT
  EXISTS (other staged row with same created_gift_id)`, and 409s on rowCount 0.
  **How to apply:** any new path that links/approves a staged row to a gift must
  keep that predicate (or finally add the partial unique index) or concurrent
  requests will double-link.

- Candidate search matches **saved donor + exact amount** (numeric(14,2) equality
  on both sides), ordered by date proximity. Donor mismatch is rejected on link;
  amount equality is NOT re-enforced server-side (UI only surfaces exact matches).
  Pure logic lives in `validateGiftLink` (api-server `lib/quickbooksLink.ts`).
