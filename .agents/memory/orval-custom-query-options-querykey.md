---
name: Orval custom query options require queryKey
description: Passing a custom `query` options object to a generated useX hook fails typecheck unless queryKey is also supplied.
---

When you override the `query` options on an orval-generated React Query hook
(e.g. `useListGiftsAndPayments(params, { query: { enabled } })`), TypeScript
errors with TS2741 "Property 'queryKey' is missing" — the generated option type
makes `queryKey` required once you pass a `query` object.

**Why:** the generated UseQueryOptions type the hook expects includes a required
`queryKey`. The hook only fills in its default key when you pass *no* options; the
moment you pass `{ query: {...} }` you must provide the whole shape.

**How to apply:** also pass the generated key helper, e.g.
`query: { enabled, queryKey: getListGiftsAndPaymentsQueryKey(params) }`. Every
generated list hook ships a matching `get<Name>QueryKey(params)`.
