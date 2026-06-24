---
name: post-merge push abort on dropped-but-present columns
description: Why interactive drizzle-kit push in post-merge silently aborts and blocks ALL additive schema, and how to keep it a no-op.
---

# Post-merge `drizzle-kit push` aborts on legacy column drift

`scripts/post-merge.sh` runs **interactive** `drizzle-kit push` (not `push-force`).
If the Drizzle schema has *dropped* a column that still physically exists in the
dev (and prod) database, push detects a data-loss DROP, prompts, and — with no
TTY — aborts the **entire** push. The damaging part: aborting skips the *additive*
changes too (new tables/columns from that merge never reach the dev DB), silently.

**Rule:** never let the schema drop a column that still exists in a live DB you
can't safely migrate. Retain it as a `@deprecated` column in the schema (mirror
`organizations.paymentIntermediaryId`) so push stays a clean no-op. Replicate the
column's EXACT db shape (type, enum, FK + onDelete, and any named index) or push
will instead generate an ALTER.

**Why:** the funders→organizations consolidation dropped `active_or_defunct`,
`parent_org_id`, `type` from the schema, but both dev and prod still hold them
(prod has live data; the only orphan data is 3 `synth-org-*` seed rows). Every
post-merge push aborted on these 3, so merged additive tables (email_intel_prompts,
task_proposals, task_suggestion_state) never landed in dev until the columns were
re-declared.

**How to apply:** if post-merge logs show "Found data-loss statements … delete X
column", the fix is to re-declare those columns in the schema (non-destructive),
NOT to approve the drop or switch to `push-force`. Actually retiring them later
needs a reviewed idempotent SQL migration applied to BOTH dev and prod by a human
(agent can't write prod) — and back-fill any orphan rows into the replacement
column first.

**Retirement pattern (when you do drop them):** make the SQL idempotent by
checking column existence (`information_schema.columns`) before any backfill so a
second run is a no-op; guard with a DO-block that counts rows where the legacy
column is populated but its replacement is NULL and `RAISE EXCEPTION` if non-zero
(never silently drop live data); backfill case-INSENSITively (the original
funders→orgs consolidation matched capital `'Active'` but seed rows used
lowercase `'active'`, which is exactly what stranded the synth-org rows). Dropping
the column auto-removes its dependent index + FK; drop the now-unused enum too
(verify single usage via `udt_name`). The 3 organizations columns
(active_or_defunct/type/parent_org_id) + `organization_type` enum were retired
this way (dev applied; prod pending human psql apply).

**Publish note:** Publish diffs dev-DB vs prod-DB (not schema-vs-DB). As long as
both DBs carry the same columns, Publish proposes no drop — the data-loss warnings
in post-merge logs are dev-push-only and do not surface at Publish.

**RENAMEs are the other recurring abort cause** (not just drops): an interactive
push can't answer the "is X a rename of Y?" prompt and aborts the whole push, so
dev stalls at the pre-rename schema every merge. Clearing it (guarded manual
pre-rename → push applies additive non-interactively → verify dev==schema, never
`push-force`) and the safe-Publish proof are in
[Schema-rename reconciliation](lifecycle-rename-reconciliation.md).
