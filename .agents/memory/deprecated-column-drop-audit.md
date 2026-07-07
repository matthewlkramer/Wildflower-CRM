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

**Why:** retiring `gifts_and_payments.grant_year` (Task #598) I claimed a clean drop,
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
