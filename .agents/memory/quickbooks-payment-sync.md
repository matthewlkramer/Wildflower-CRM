---
name: QuickBooks payment sync
description: One-way QuickBooks Online → CRM incoming-payment pull (OAuth, staged review queue, approve→gift). Durable decisions + env/config gotchas.
---

# QuickBooks Online → CRM payment sync

One-way **pull only** (SalesReceipt / Payment / Deposit). Admin connects once via
Intuit OAuth; scheduled + on-demand worker pulls incoming money, auto-matches
donors, stages into a review queue; approve mints a `gifts_and_payments` row.

## Durable decisions / invariants

- **Idempotency key** is `(realmId, qbEntityType, qbEntityId)` (DB unique). Staged
  rows are **retained** after approve/reject so re-pulls dedupe — never delete them.
- **Approve mints the gift inside a tx** and must run `validateGiftInvariants`
  (Donor XOR: exactly one of organization/individual/household). The staged-payment
  donor pickers therefore send all 3 FKs (null the rest), same pattern as the rest
  of the CRM's donor pickers.
- **Pull-only by design** — never write back to QuickBooks.
- **Enum canonical form is DB snake_case.** The client normalizes QB types to
  `sales_receipt | payment | deposit`; the OpenAPI spec, generated zod/hooks, and
  the frontend must use those exact values (frontend maps to pretty labels at
  render). Match status is only `matched | unmatched` — the matcher returns
  unmatched for an ambiguous/absent candidate set, so don't add an "ambiguous"
  enum value unless the matcher actually starts emitting it.
- **Single active connection invariant.** "Active" = latest granted, non-revoked
  row. To keep exactly one: on connect, revoke all *other* non-revoked rows; on
  disconnect, revoke *all* non-revoked rows (not just the active one) — otherwise
  an older non-revoked realm silently resurfaces as active after a disconnect.
- **Schema needs a hand-written numbered SQL migration** in `lib/db/migrations/`
  (e.g. `0011_quickbooks_payment_sync.sql`), not just `drizzle push`. CREATE TYPE
  has no IF NOT EXISTS — guard enums with `DO $$ … EXCEPTION WHEN duplicate_object`.

## Env / config gotchas (cost real time)

- **Intuit "development" keys ⇒ sandbox only.** Dev keys can read *only* a sandbox
  company via host `sandbox-quickbooks.api.intuit.com`. "Production" keys read live
  companies via `quickbooks.api.intuit.com`. Using the wrong host for the key type
  makes every data query fail. Host is env-derived: `QUICKBOOKS_API_BASE`
  (defaults to the production host). The OAuth/token endpoints
  (appcenter.intuit.com / oauth.platform.intuit.com) are the **same** for both.
- **Client ID/secret are a single global secret pair** (`QUICKBOOKS_CLIENT_ID` /
  `QUICKBOOKS_CLIENT_SECRET`). Supporting dev+prod keys simultaneously would need
  two credential sets + env-switching — not worth it; pick one (we chose
  production). Switching key types = re-request the secrets, drop any
  `QUICKBOOKS_API_BASE` override so dev uses the production host too.
- **Redirect URI must match exactly, per key set.** Intuit keeps separate
  redirect-URI lists for development vs production keys. The app sends an
  env-derived callback: in dev it's the `REPLIT_DOMAINS` host
  (`https://<dev-domain>/api/quickbooks-oauth/callback`), in prod
  `https://wfcrm.replit.app/api/quickbooks-oauth/callback`. To OAuth-test in dev
  you must register the **dev** callback under the key set you're using.
  Override via `QUICKBOOKS_OAUTH_REDIRECT_URI` if needed.

## Testing gotcha

- Clerk users auto-provision (`role='team_member'`) on their **first authenticated
  API call**. An e2e `[DB] UPDATE users SET role='admin'` must run *after* an
  authenticated page load, or it updates 0 rows and the admin-gated QuickBooks
  settings section never renders. (See also clerk-admin-e2e-testing.)
