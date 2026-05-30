---
name: api-server runs a built bundle, not src
description: Why Drizzle schema/DB drift in the Wildflower CRM only surfaces (or clears) after restarting the api-server workflow.
---

The `@workspace/api-server` workflow `dev` script does `pnpm run build && pnpm run start` — it serves an **esbuild bundle in `dist/`**, NOT the TypeScript source at runtime. (`@workspace/db` itself resolves to `./src`, but it is bundled into the api-server build at build time.)

**Consequence:** a running server reflects the schema as it was *when the workflow last started*, not the current source. If a Drizzle column is removed from a table's source (or dropped from the DB by `drizzle-kit push`) but the workflow is not restarted, the live server keeps emitting the old query.

**Symptom seen:** funders list returned 500 `column "national_priorities" does not exist` even though no current schema file defines that column. Root cause was a stale build from before the column was removed — NOT anything the current change touched. Restarting the workflow rebuilt from current source and the error disappeared.

**How to apply:** When you see a `column ... does not exist` 500 whose column is absent from the current schema source, suspect a stale build before assuming your change caused it. Restart the workflow to rebuild, then re-check the *newest* log file (old log files keep the pre-restart errors and will mislead a grep).
