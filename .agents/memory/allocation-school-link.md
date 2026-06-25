---
name: Allocation school link (pledge vs gift)
description: How pledge_allocations and gift_allocations link to a concrete school, and the deliberate display asymmetry between them.
---

Both `gift_allocations` and `pledge_allocations` carry a nullable
`school_recipient_id` FK → `schools.id` (onDelete restrict) alongside the older
`direct_to_school` boolean. The boolean means "funds flow to *some* school"; the
FK names *which* school.

**Display asymmetry (the non-obvious part):**
- Gift allocations resolve the school *name* for the usage label from a SERVER
  `display_usage` trigger/column.
- Pledge allocations deliberately have **NO** `display_usage` trigger/column. The
  pledge UI resolves the school name CLIENT-SIDE via `useListSchools` (a
  `useSchoolNameMap` helper in `allocation-editors.tsx`). Do **not** add a pledge
  display_usage trigger to "match" gifts — the asymmetry is intentional.

**Why:** the pledge side never needed a denormalized display column; keeping the
name resolution client-side avoids a new trigger + backfill on a money-trail table.

**Gotchas / how to apply:**
- The gift "School recipient" field is a plain text `Input` ("School ID"), NOT an
  EntityPicker. There is no `useSchoolOptions` hook. Mirror the raw Input for
  parity; don't reach for a picker that doesn't exist.
- API keeps the two coherent: a truthy `schoolRecipientId` forces
  `directToSchool=true`; an explicit `directToSchool=false` clears the school.
  Only caller-touched keys are overridden (a `schoolRecipientId: null` body just
  clears the FK, leaving the boolean alone — "direct to an unspecified school").
- School does **NOT** feed revenue coding — `derivePledgeAllocationCoding` inputs
  exclude it. Keep it that way.
