---
name: anonymous funders/people visibility
description: How the UI-only "anonymous" name-hiding works for funders/people, and which surfaces still leak.
---

`anonymous` boolean on funders + people. When true, the real name is masked to "Anonymous" for everyone except the record owner (`ownerUserId`) and admins (`users.role === "admin"`).

**Mostly UI-only, with one server-side exception class.** Surfaces that return the full `Organization`/`Person` object still carry the real name in the API response and rely on the frontend to hide it (explicit product decision — don't add redaction there unless asked). BUT denormalized **join/aggregate projections** that expose only a bare name string ARE now masked server-side (see below).

**Two separate helpers (`artifacts/wildflower-crm/src/lib/visibility.ts`) — keep them distinct:**
- `canSeeIdentity(entity, viewer)` → controls **name display**. Returns true when the record is not anonymous, OR viewer is admin/owner.
- `canManageIdentity(entity, viewer)` → controls the **Anonymous toggle**. Admin/owner only, **independent of the anonymous flag**.
- **Why distinct:** gating the toggle on `canSeeIdentity` is a bug — since `canSeeIdentity` is true for any non-anonymous record, any viewer could then flip the toggle. The toggle must be owner/admin-only regardless of current anonymity.

**Join-projection leak class — now masked server-side.** Relational references that come from SQL join *projections* expose only a name string (e.g. `PeopleEntityRole.personName`, donor display names, `activeOrganizationNames`) without `anonymous` + `ownerUserId`, so they can't be masked client-side. These are now redacted on the server via a shared helper `artifacts/api-server/src/lib/identityVisibility.ts` (`canSeeIdentity`/`maskName`/`getViewer`, `ANON_LABEL`). **Pattern:** carry each anonymizable join's `anonymous`+`ownerUserId` as aliased helper columns in the SELECT, then in the consumer destructure them OUT (`...rest`) so they never leak, overlaying the masked name. Covered: donor names on opportunities + gifts (incl. primary contact), `people.activeOrganizationNames`/`pastOrganizationNames` (JSON-agg carrying the flags, remapped to a masked `string[]`), `organizations.primaryContactPersonName`, and every consumer of `peopleEntityRolesSelect` (a shared `maskPeopleEntityRoles` masks household members, payment-intermediary people, role rows). **Households are never anonymizable** (only orgs + people). Response SHAPES are unchanged — only values are masked, so no OpenAPI/codegen change was needed.

**Exception — `/top-priorities` masks server-side.** Unlike the UI-only rule above, the top-priorities endpoint redacts on the server (`maskOrgName`, affiliatedPeople names, and now `openAsks[].opportunityName`). When a parent org/person is not visible to the viewer, its open-ask opportunity titles must also be masked to "Anonymous" — opportunity names routinely embed the donor name (e.g. "FY27 Arthur Rock gift"), so showing them would defeat the masked entity name. Any new identity-bearing field added to this endpoint must be masked in lockstep with the parent's `canSeeIdentity`.
