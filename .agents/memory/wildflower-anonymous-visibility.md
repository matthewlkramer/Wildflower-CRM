---
name: anonymous funders/people visibility
description: How the UI-only "anonymous" name-hiding works for funders/people, and which surfaces still leak.
---

`anonymous` boolean on funders + people. When true, the real name is masked to "Anonymous" for everyone except the record owner (`ownerUserId`) and admins (`users.role === "admin"`).

**It is UI-only.** The server does NOT redact — the real name is still in API responses; the frontend hides it. This was an explicit product decision, not an oversight. Do not add server-side redaction unless asked.

**Two separate helpers (`artifacts/wildflower-crm/src/lib/visibility.ts`) — keep them distinct:**
- `canSeeIdentity(entity, viewer)` → controls **name display**. Returns true when the record is not anonymous, OR viewer is admin/owner.
- `canManageIdentity(entity, viewer)` → controls the **Anonymous toggle**. Admin/owner only, **independent of the anonymous flag**.
- **Why distinct:** gating the toggle on `canSeeIdentity` is a bug — since `canSeeIdentity` is true for any non-anonymous record, any viewer could then flip the toggle. The toggle must be owner/admin-only regardless of current anonymity.

**Leak class to watch:** relational references that come from SQL join *projections* expose only a name string (e.g. `PeopleEntityRole.personName`) without `anonymous` + `ownerUserId`, so they CANNOT be masked client-side. As of this writing, role rows / household members / colleague lists (individual detail) and funder-people affiliation rows are still unmasked. Masking them needs those flags added to the projection (OpenAPI + server SQL + codegen) — still UI-only, just a wider contract change. Surfaces that use the full `Funder`/`Person` objects (list pages, command palette, funder parent/child cards) carry the flags and ARE masked.

**Exception — `/top-priorities` masks server-side.** Unlike the UI-only rule above, the top-priorities endpoint redacts on the server (`maskOrgName`, affiliatedPeople names, and now `openAsks[].opportunityName`). When a parent org/person is not visible to the viewer, its open-ask opportunity titles must also be masked to "Anonymous" — opportunity names routinely embed the donor name (e.g. "FY27 Arthur Rock gift"), so showing them would defeat the masked entity name. Any new identity-bearing field added to this endpoint must be masked in lockstep with the parent's `canSeeIdentity`.
