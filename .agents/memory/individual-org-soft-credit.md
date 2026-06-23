---
name: Individual org soft-credit (lifetime giving / last gift)
description: How a person is credited for an organization's gift, and why the paths stay disjoint.
---

# Individual org soft-credit

A person's **Lifetime giving** / **Last gift** (derived, never stored) fold in an
**organization-donor** gift when the person is its **primary contact**, its
**advisor**, OR a **current principal** of the donor org
(`people_entity_roles.connection='principal' AND current='current'`). The
Katherine Bradley → Bradley Holdings case is why principal must be covered even
when someone else is the primary contact. Credit is a single blended number — no
separate "credited giving" line.

**Why disjoint / no double-count:** org-credit is scoped to
`organization_id IS NOT NULL` gifts. Donor XOR guarantees direct (individual) and
household gifts have a NULL organization_id, so the org-credit set never overlaps
the direct + household sums. The three signals are OR-combined inside ONE subquery
so a gift matching several still counts once.

**How to apply / where it lives:** one shared `sql` fragment per route reused by
SELECT + presence filters so they can't drift —
`peopleOrgCreditGiftWhere` in `routes/people.ts` (lifetime + most-recent),
`personOrgCreditGiftWhere` in `routes/topPriorities.ts` (last-gift date + amount).
The topPriorities last-gift AMOUNT is a UNION-then-`ORDER BY date DESC LIMIT 1`
so it tracks the same gift the date expression reports. **Org/household record
totals are intentionally unchanged** (org keeps its full total AND the credited
individual shows it — accepted "double count" across record types).

**Archived gifts:** all three paths (direct, household, org-credit) filter
`archived_at IS NULL`. The pre-existing direct/household expressions did NOT
filter archived before this change — aligning them slightly shifts existing
personal/household totals for anyone with archived gifts.

Index `people_entity_roles(person_id, connection)` backs the principal lookup;
the primary-contact / advisor / organization legs ride existing gifts indexes.
