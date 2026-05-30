---
name: api-zod must stay environment-neutral
description: lib/api-zod is consumed by both the Express server and the browser bundle, so it can't use node-only or DOM-only globals.
---

`@workspace/api-zod` (`lib/api-zod/src/index.ts`) holds hand-written request validators/invariant helpers on top of the orval-generated schemas, and it is imported by **both** the api-server and the React frontend.

**Constraint:** its tsconfig provides neither the DOM lib nor `@types/node` URL global, and importing `node:url` would break the browser/vite bundle. So validation code here must be environment-neutral.

**Why:** adding `new URL(...)` for http(s) URL validation failed typecheck with `TS2304: Cannot find name 'URL'`. Fixed by using a regex scheme check (`/^https?:\/\/\S+$/i` after trimming) instead of the `URL` constructor.

**How to apply:** When adding validation/util code to api-zod, avoid `URL`, `Buffer`, `process`, `document`, etc. Prefer pure string/regex logic. The established invariant pattern is: a pure `validateXInvariants(state): InvariantIssue[]` helper + a `CreateXBodyRefined = CreateXBody.superRefine(...)`; PATCH routes re-validate the MERGED `{ ...existing, ...body }` state at the route, not the body alone.
