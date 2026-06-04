---
name: clerk admin-gated e2e testing
description: How to e2e-test admin-only features in wildflower-crm when testClerkAuth provisions non-admin users
---

# Testing admin-gated features with testClerkAuth

`runTest({ testClerkAuth: true })` signs in a fresh Clerk user, and first-login
provisioning gives that user `role = 'team_member'` (see `requireAuth.ts`
`provision`). Admin-gated endpoints return 403 and the UI hides the card, so a
plain testClerkAuth sign-in CANNOT see any admin section.

**How to apply:** in the test plan, add a `[DB]` step right after the
`[Clerk Auth]` sign-in that promotes the user, e.g.
`UPDATE users SET role = 'admin' WHERE email = '${login_email}';`
Then navigate to `/admin`. Admin sections gate on a 403 from their list
endpoint and `return null` when not admin, so without the promotion the whole
card silently disappears (no error shown).

**Why:** admin gating is enforced server-side (`requireAdmin` checks
`getAppUser(req).role === "admin"`), independent of Clerk; the Clerk session
only proves identity, not role.
