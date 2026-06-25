---
name: Wildflower Foundation — org row vs entity slug
description: The Foundation exists as BOTH an organizations row and an entities slug; they mean different things. Don't confuse them.
---

The "Wildflower Foundation" appears twice in the data and they are NOT the same thing:

- **organizations row `rec6Imee3i0zIjcJ8`** (name "Wildflower Foundation",
  domain `wildflowerschools.org`) — the organization where **staff hold roles**.
  "Who works at the Foundation / internal staff / foundation partners" =
  `people_entity_roles.organization_id = rec6Imee3i0zIjcJ8 AND current = 'current'`.
- **entities slug `wildflower_foundation`** — the internal FUND entity. Money,
  goals, and reconciliation attribute here (people roles never point at `entities`).

**Why:** picking the wrong identifier silently returns nothing/wrong rows — using
the entity slug to find staff, or the org id for money attribution, both fail
quietly with no error.

**How to apply:** "who works at the Foundation" → the ORG id. "which fund did this
money land in" → the ENTITY slug. Treat the org-role test as the broad definition
of internal staff (any current role at that org, not just an employee connection
type).
