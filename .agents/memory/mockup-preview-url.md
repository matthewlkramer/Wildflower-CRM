---
name: Mockup preview iframe URLs
description: Canvas iframes for mockup-sandbox previews must use the /__mockup proxy path, never :8000.
---

In this monorepo the mockup-sandbox dev server is NOT exposed on external port
8000 (the generic canvas-skill guidance of "append :8000" fails with an
unreachable host — frames show "Hmm... we couldn't reach this app").

**Rule:** build canvas iframe URLs as
`https://$REPLIT_DOMAINS/__mockup/preview/<folder>/<Component>`.

**Why:** all traffic routes through the shared proxy on port 80; the
mockup-sandbox artifact is mounted at the `/__mockup` path prefix. Curl check:
`:8000` → 000, `/__mockup/...` → 200.

**How to apply:** when creating/updating any mockup preview iframe, copy the
URL form of an existing working frame (getCanvasState shows it) or use the
`/__mockup` form above. Screenshots via localhost:80/__mockup/... succeeding
does NOT prove the external `:8000` URL works — they take different routes.
