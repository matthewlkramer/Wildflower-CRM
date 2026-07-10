---
name: Deprecated-column drop audit
description: How to prove a gifts/DB column is truly unreferenced before shipping a physical DROP migration.
---

Before claiming a column is a "pure drop" (no code reads/writes it), the grep audit
must cover THREE reference forms, not just one:

1. **Dot-access reads/writes** — `something.colName`.
2. **Object-key writes** — `colName: value` inside `.values({...})` / `.set({...})`
   inserts and updates. Grepping only `.colName` MISSES every object-key write.
3. **Table alias() reads** — `const x = alias(table, "...")` creates a SECOND
   identifier, so the column is also read as `x.colName` where the base table name
   never appears. Grepping the table/prop name against the base symbol misses these.

**Why:** retiring `gifts_and_payments.grant_year` I claimed a clean drop,
but `quickbooks/shared.ts` read it via `resolvedGift.grantYear` where
`resolvedGift = alias(giftsAndPayments, "resolved_gift")`. My grep on the base symbol
missed the alias read; only the full `pnpm run typecheck` (leaf api-server) caught it
(TS2339). Separately, schema tombstone comments can be aspirational/stale — the
`processor_fee` comment said "no longer written" while `reconciliationCommit.ts` /
`reconciliationBundleCommit.ts` / `stripeGift.ts` / `giftFinalAmount.ts` still wrote it.

**How to apply:** for any deprecated-column drop, (a) grep the prop name broadly (all
three forms) AND grep for `alias(<table>` to enumerate alias identifiers, then grep
those; (b) do NOT trust the schema `@deprecated` comment about read/write status —
verify against the code; (c) treat the full typecheck (which compiles `src/__tests__`
too, since api-server tsconfig `include: ["src"]`) as the authoritative "no residual
reference" gate, not the grep. A dev-runtime test CANNOT validate a prod drop because
the non-destructive strategy keeps the column in dev through Publish — validation of a
column drop is inherently static.

## "Unread" is not enough to drop — is the STORED value still authoritative?

A column can be absent from the serving/read path yet still be UNDROPPABLE because its
stored values are the only source for some restore/rollback. Split the decision on two
axes, not one:

- `processor_fee` — unread AND its value is re-derived from linked payments
  (`derivedProcessorFee` = SUM of linked Stripe `fee_amount` + non-stripe Donorbox
  `processing_fee`). Stored value is redundant → **safe to drop**.
- `original_human_crm_amount` — also unread by ordinary responses, BUT
  `unstampGiftFinalAmount` reads it to RESTORE the human amount on a QB/Stripe revert,
  and prod had 704/793 gifts non-null. The stored snapshot is irreplaceable →
  **do NOT drop** without a parity/backfill pass first.

**Why:** dropping a column whose value is a one-way snapshot (no derivation, no other
source) silently destroys restore data even though nothing "reads" it in the normal
path. Always ask "what recreates this value after the drop?" — if the answer is
"nothing," it is not a pure drop.

**How to apply:** for every candidate column, (a) run a READ-ONLY prod count of
non-null rows before deciding; (b) trace whether any revert/rollback/derivation path
still consumes it; (c) when a test asserted the dropped column via a raw
`db.select()` helper (`$inferSelect` — has NO derived read-model fields like
`derivedProcessorFee`), re-point the assertion to the derivation's SOURCE row (e.g. the
linked charge's `feeAmount`), not the derived field the raw row never had.
