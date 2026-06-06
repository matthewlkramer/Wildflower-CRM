---
name: Vite config build-time env gating
description: Why artifact vite.config.ts must not require PORT/BASE_PATH at build time, only at serve time.
---

# Vite config env gating: validate PORT/BASE_PATH only in `serve`

The deployment build runs the root `pnpm run build`, which builds **every**
artifact in the workspace — including design-only artifacts (e.g. mockup-sandbox)
that have **no production service** and are never deployed.

If an artifact's `vite.config.ts` throws `"PORT environment variable is required"`
(or BASE_PATH) at config-load time, the production build crashes, because
PORT/BASE_PATH are only injected when **running** the dev server (workflow env /
`artifact.toml [services.env]`), not during a production `vite build`.

**Rule:** gate runtime env validation to serve mode. Use the function form:

```ts
export default defineConfig(async ({ command }): Promise<UserConfig> => {
  if (command === "serve") {
    // throw if PORT / BASE_PATH missing
  }
  return { base: process.env.BASE_PATH ?? "/", ... };
});
```

- `base` is a **build-time** Vite setting. Falling back to `"/"` is safe only
  when the artifact is served at root in production. If an artifact's prod path
  ever changes from `/`, its deployment build env MUST set BASE_PATH explicitly.
- Needs explicit `Promise<UserConfig>` return annotation, or TS picks the sync
  overload and errors (TS2769 "no properties in common with UserConfig").

**Why:** a deploy build failure was traced to mockup-sandbox + wildflower-crm
configs throwing on missing PORT during the workspace-wide build. Started failing
once a new artifact (canvas/mockup-sandbox) was added after a prior successful
publish.
