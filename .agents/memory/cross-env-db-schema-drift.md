---
name: Cross-environment DB schema drift
description: Why a task's dev DB can lag a predecessor's schema change, and why blunt drizzle-kit push is dangerous here.
---

# Cross-environment DB schema drift

When a task "builds on" a predecessor task, only the predecessor's **code**
propagates into the new task environment — the dev **database** state does not.
So a task can find its dev DB missing a column the merged code already selects
(e.g. a successor of the loss_type / calculated-status work found dev had no
`loss_type` column, so every full `db.select()` on that table 500s).

**Rule:** reconcile such gaps **additively** with targeted SQL
(`CREATE TYPE ... ; ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...; UPDATE ...`),
not with `pnpm --filter @workspace/db run push`.

**Why:** `drizzle-kit push` reconciles the *entire* schema against the dev DB at
once. This repo's dev DB also carries unrelated drift (e.g. legacy
`organizations` columns active_or_defunct / parent_org_id / type that the
consolidated schema dropped). Push bundles those drops into the same prompt —
accepting it deletes columns with live rows (data loss). The push aborts at the
data-loss confirmation; do not force it.

**How to apply:** if push reports data-loss statements for tables/columns you did
not touch, abort. Apply only the additive bits your task needs via `executeSql`
in the code_execution sandbox (the standard dev-DB SQL path). The api-server runs
a built bundle, so after adding a column, a workflow restart picks it up cleanly.

**Refinement (when drift is broad + purely additive):** if a dev DB lags many
schema columns at once (a frontend-only task can still hit this because the merged
backend code selects them), `drizzle-kit push` IS safe to run *once you first*
(1) apply each rename by hand — find the truth in the schema's `// Renamed from X`
comments (e.g. gifts `payment_on_pledge_id → opportunity_id`, opps
`was_pledge → written_pledge`) and `ALTER ... RENAME COLUMN`, so push no longer
prompts create-vs-rename; and (2) confirm any apparent "DB-only" column is not
actually a *current* multi-line schema def (a single-line column-name regex
misreads `text(\n  "col")` as missing → false "deprecated/drop" alarm; grep the
raw column string before trusting it). After the renames, push applied all
additive columns/indexes/missing tables with **zero** data-loss prompts. Net: the
"never push" rule is really "never push *while a rename or real drop is in the
diff*"; a verified additive-only diff is fine.
