---
name: clerk admin-gated e2e testing
description: How to e2e-test admin-only features in wildflower-crm when testClerkAuth provisions non-admin users
---

# runTest MUST pass testClerkAuth:true for this Clerk-protected app

`runTest({ ..., testClerkAuth: true })` — the flag is a top-level **parameter of
the runTest call**, not just a `[Clerk Auth]` step in the plan. If you write a
`[Clerk Auth]` step but forget the `testClerkAuth: true` argument, the subagent
falls back to driving the REAL Clerk sign-in UI/captcha against the dev instance,
which loops/stalls and burns the ENTIRE code_execution budget — every run then
hits the 600s code_execution hard cap and is killed (both wrapper AND subagent),
so you never get a result and DB seed steps run but later browser steps never do.
With the flag, sign-in is instant and the full grouping/match/revert flow
finishes well under 600s and returns status in-band.

**How to apply:** always pass `testClerkAuth: true` as an argument to `runTest`
for any wildflower-crm browser test; treat repeated "[vite] connecting…" + Clerk
dev-key warnings in the browser console with no test progress as the signature of
a missing flag (not a slow app).

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
