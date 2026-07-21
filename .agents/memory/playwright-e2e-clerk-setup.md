---
name: Committed Playwright e2e specs — browser + Clerk sign-in requirements
description: Constraints for running artifacts/wildflower-crm/e2e specs in this NixOS environment.
---

Four durable constraints (all already honored by the committed config/specs — keep them true):

1. **Browser must be the Nix system Chromium.** Playwright's downloaded browser cannot
   load its shared libraries on NixOS. The config resolves the system binary to an
   ABSOLUTE `executablePath` (a bare command name fails Playwright's existence check).
2. **`clerkSetup()` must run in Playwright global setup** before any
   `setupClerkTestingToken` call, or specs fail with "Clerk Frontend API URL is required".
3. **Sign-in identifiers must be `+clerk_test` test emails** — `clerk.signIn` with
   `email_code` rejects plain emails. The Clerk user must pre-exist. The Clerk dev
   instance has a user quota; when exceeded, delete stale timestamped test users via the
   Clerk API (the CRM `cleanup:test-users` script only touches the CRM DB, never Clerk).
   Older specs still using a plain shared email will not sign in this way.
4. **Authed API calls from a spec must use `page.request`** (shares the signed-in
   context's cookies); the standalone `request` fixture has its own cookie jar → 401.

**Why:** each was hit as a hard failure when first running committed specs directly
(vs. the testing subagent's own infra, which bypasses all four).

Flakiness: tiny menu triggers on polling pages lose the actionability race — forced-click
inside a `toPass()` retry; raise `test.setTimeout` (sign-in alone ~10s). Playwright output
dirs (`test-results/`, `playwright-report/`) are gitignored — keep them out of commits.
