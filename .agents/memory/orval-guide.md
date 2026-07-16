---
name: Orval / React Query patterns and pitfalls
description: Three concrete pitfalls from Orval-generated hooks: invalidation key prefix, custom query options shape, and coerce.boolean() query-param behavior.
---

## 1. Query-key invalidation must include the "/api" prefix

Orval generates React Query keys like `["/api/staged-payments", params]`. A
`queryClient.invalidateQueries({ queryKey: [...] })` does a **prefix match** — omitting
`/api` silently matches nothing:

```ts
// WRONG — never refetches, UI looks "stuck" after mutation
queryClient.invalidateQueries({ queryKey: ["/staged-payments"] });

// CORRECT
queryClient.invalidateQueries({ queryKey: ["/api/staged-payments"] });
// OR (safest): use the generated helper
queryClient.invalidateQueries({ queryKey: getListStagedPaymentsQueryKey(params) });
```

The bug is invisible — no error, the mutation succeeds, but the cache is never marked
stale. Prefer the generated `get<Op>QueryKey()` helpers for all invalidation calls. To
audit: grep `queryKey: ["/` in a page file and check for prefixes missing `/api`.

---

## 2. Custom query options require queryKey

Passing a custom `query` options object to an orval-generated hook fails TypeScript with
TS2741 "Property 'queryKey' is missing" — the generated UseQueryOptions type makes
`queryKey` required the moment you pass any `query` object:

```ts
// WRONG — TS2741
useListGiftsAndPayments(params, { query: { enabled } });

// CORRECT — always supply the generated key helper alongside
useListGiftsAndPayments(params, {
  query: { enabled, queryKey: getListGiftsAndPaymentsQueryKey(params) }
});
```

Every generated list hook ships a matching `get<Name>QueryKey(params)` helper.

---

## 3. Boolean query params: the string "false" coerces to true

Orval-generated Zod validators for boolean **query params** use `zod.coerce.boolean()`.
`Boolean("false") === true`, so `?flag=false` is treated as `flag=true`.

**Why:** discovered when adding `includeStageAskTotals` to the opportunities list
endpoint — a client sending the literal string `"false"` would still trigger the extra
totals query.

**Design rule:** model boolean query params as opt-in **presence flags** — clients send
the param only when they mean `true`; absent = false. If an explicit false ever matters,
model it in the OpenAPI spec as `enum: [true, false]` string + transform, or check
`req.query.x === "true"` server-side rather than relying on the generated Zod schema.
