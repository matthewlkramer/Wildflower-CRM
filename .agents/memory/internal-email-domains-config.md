---
name: internal email domains made admin-configurable
description: Internal staff email domains moved from a hardcoded Set to a DB singleton; matcher loads them with a short cache.
---

# Internal staff email domains are admin-configurable

Internal staff domains (formerly the hardcoded `INTERNAL_DOMAINS` Set in the
api-server emailMatcher) now live in the `internal_email_domains` singleton
settings table and are editable on the Admin screen.

**Rule:** the matcher's `normalizeForMatching` takes the internal-domain set as
an argument (default = `DEFAULT_INTERNAL_DOMAINS` so the pure helper / unit
tests behave like the old constant). `matchEmails` loads the live set via
`loadInternalDomains` (short-lived in-memory cache). The Admin PUT route calls
`invalidateInternalDomainsCache` so edits apply immediately.

**Why:** adding a new staff Workspace domain previously needed a code change +
deploy. The seed (the original two domains) is applied both by a SQL migration
and by self-seed on first GET, and `loadInternalDomains` falls back to the two
defaults when the singleton row is absent — so sync behavior is unchanged on
rollout even before any admin opens the screen.

**How to apply:** when touching sync domain-dropping behavior, change the
settings table / matcher loader, not a constant. Mirror the
`calendar_meeting_filters` singleton pattern for any similar global config.
