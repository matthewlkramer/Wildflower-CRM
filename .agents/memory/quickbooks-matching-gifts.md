---
name: QB matching gifts vs accounting duplicates
description: Why donor+amount+date must NOT be used to detect duplicate QB payments; the only reliable same-money signal is QB LinkedTxn.
---

# Matching gifts look identical to duplicates — but aren't

Two gifts of the **same donor + same amount + same date** are NOT necessarily a
duplicate. A **matching gift** is exactly this: one direct gift from the donor and
one indirect gift (employer/foundation/community-foundation conduit) of identical
size on the same day. Both are real money that arrived.

**Why:** QuickBooks is authoritative for "money that actually arrived." Each
distinct QB Payment entity (distinct `qb_entity_id`) is a distinct real inflow.
Real example: Scholler 2024-02-02 had `payment 28838` (Scholler Foundation, $5,000)
AND `payment 28845` (Saint Paul & Minnesota Foundation, $5,000) — two separate
payments, no `LinkedTxn` between them = two real gifts ($10,000 total), even though
donor+amount+date were identical.

**How to apply:**
- NEVER dedupe staged_payments or gifts by (donor, amount, date). It will wrongly
  flag legitimate matching gifts.
- The ONLY trustworthy "same money" signal is QuickBooks' own linkage: a **Deposit**
  carrying a `LinkedTxn` back to the **Payment/SalesReceipt** it batches. Same
  `qb_entity_id`, or a Deposit→Payment LinkedTxn = same money. Anything else = treat
  as distinct real inflows.
- Because one CRM gift links to one staged row (partial-unique index), linking two
  matching-gift payments to a single existing gift makes them fight over the one
  link (linking one knocks the other back to pending). The correct resolution for a
  genuine second/matching gift is to **mint its own gift** (create-gift), not link
  or exclude.
