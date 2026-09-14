---
status: current-status
last_verified: 2026-09-14
---

# CRM user management

The admin-only **Users** page at `/admin/users` lists all CRM user records,
including deactivated accounts and profiles added before their first sign-in.
It supports search, access filtering, adding a profile, editing names and the
existing role, and deactivating or restoring access. The existing ownership
transfer tool remains under Admin → Users and is linked from the directory.

`users.role` and `users.archived_at` remain the access authorities. No parallel
invitation or access-status table is introduced. New profiles use a generated
placeholder `clerk_id`; the existing first-login email-adoption path attaches
the Google/Clerk identity to that same user ID and preserves its role and record
ownership. First-login email is normalized to lowercase. Existing Google/Clerk
sign-in eligibility remains the primary account gate; this directory is not an
invite-only allowlist and does not change existing role permissions elsewhere.

Adding a profile accepts only a `@wildflowerschools.org` address. It does not
create a Google account or send mail. An existing email, including a deactivated
one, returns a conflict and must be edited/restored explicitly. Login email and
Clerk identity cannot be changed by the management PATCH endpoint.

All management endpoints require an admin. Access mutations run inside one
transaction with an audit entry and a serialized user-table lock, then re-check
the actor's current role and active status. This prevents two simultaneous role
edits through these endpoints from removing each other's authority. A user
cannot change their own role or deactivate themselves through these controls.
Archive preserves foreign-key ownership and history; `requireAuth` rejects
archived users, including an archived profile attempting its first sign-in.

The directory and user responses exclude extension credentials. The existing
owner-picker `/users` response still includes only active usable identities by
default; its `includeArchived=true` option requires admin access.

No schema migration is needed. Tests cover permission rejection, duplicate and
domain validation, field allowlisting, credential omission, audit history,
archive/restore, self-lockout prevention, first-sign-in adoption, and the form.
