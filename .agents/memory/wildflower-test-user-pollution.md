---
name: e2e test users pollute the owner filter
description: Why "Test Dev"/"Test Admin" rows keep showing up in the owner dropdown and how to clean them
---

The owner filter (owner-multi-filter, sourced from the active users list) shows
any user with a usable identity (first/last name). Running e2e tests via the
testing skill's `testClerkAuth` programmatically signs in with
`@wildflowerschools.org` emails, and `requireAuth` auto-provisions a real user
row for each sign-in named "Test Dev" / "Test Admin". These accumulate and
clutter the owner dropdown.

**Why:** auth auto-provisioning + e2e sign-ins create persistent user rows in
the dev DB; nothing prunes them.

**How to apply:**
- To clean up: delete users where `(first_name='Test' AND last_name IN ('Dev','Admin'))`.
  Most user FKs are RESTRICT, so first clear blocking refs — usually leftover
  e2e `notes` (bodies like "E2E note..."/"...e2e..."). email_/calendar_/
  google_oauth columns are CASCADE and clear automatically. owner_user_id is
  nullable on all owning entities.
- They WILL reappear after any future e2e run. This is expected, not a bug.
- The nameless `user_...@unknown.com` rows have no usable identity, so they are
  already filtered out of the owner dropdown — leave them.

**Canonical predicate + lockstep:** the identity test for an automated account is
`first_name ILIKE 'Test' AND last_name IN ('Dev','Admin')`. It lives in
`scripts/src/cleanup-test-users.ts` and is mirrored in the admin email-intel
"Reviewer feedback" feed (`GET /admin/email-intel/feedback`, `reviewerSource`
param: `all` vs `real`; `real` = NOT EXISTS a test resolver, NULL resolvers
kept). Any change to the predicate must update BOTH places or the feed/cleanup
drift. The `prompts/generate` endpoint still samples test feedback (not yet
filtered) — a known related gap.

**Archived test user blocks the next e2e run:** `cleanup:test-users` ARCHIVES
(not deletes) the Test Dev/Admin rows. A later `testClerkAuth` sign-in with the
same email then gets API-wide `403 user_archived` (list pages show "0 total").
Fix before the run: `UPDATE users SET archived_at = NULL WHERE email ILIKE
'testdev@wildflowerschools.org'`; re-run cleanup after.
