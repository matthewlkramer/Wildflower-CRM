---
name: Orval zod query-param booleans coerce "false" to true
description: Generated query-param validators use zod.coerce.boolean(), so any non-empty string (incl. "false") parses as true.
---

Orval-generated Zod validators for boolean **query params** use `zod.coerce.boolean()`. `Boolean("false") === true`, so `?flag=false` is treated as `flag=true`.

**Why:** discovered adding `includeStageAskTotals` to the opportunities list endpoint; a client sending the literal string "false" would still trigger the extra totals query.

**How to apply:** design boolean query params as opt-in presence flags (clients send the param only when true, e.g. pipeline sends `includeStageAskTotals: true`). If a tri-state or explicit false ever matters, model it in the spec as `enum: [true, false]` string + transform instead of a plain boolean, or check `req.query.x === "true"` server-side.
