---
name: Reporting-deadline donor filter
description: Why donor filtering on the /tasks endpoint must join through the linked opportunity, not the task's own entity arrays.
---

Reporting-deadline tasks are created carrying ONLY `opportunityIds` — they do
NOT copy the opportunity's donor into the task's `organizationIds` /
`personIds` / `householdIds` arrays.

**Why:** the creation flow (reporting-deadlines-dialog) inserts a minimal task
linked to the opportunity; the donor (org / individual / household) lives on
`opportunities_and_pledges`, not on the task.

**How to apply:** to filter reporting deadlines (or any opportunity-linked
task) by donor, do NOT reuse the task's `organizationId`/`personId`/
`householdId` params (those match the task's own arrays and will return
nothing). Instead use the `/tasks` `opportunityOrganizationId` /
`opportunityHouseholdId` / `opportunityIndividualGiverPersonId` params, which
EXISTS through `opportunity_ids` into the opportunity's donor column.
`${opp.id} = ANY(${tasks.opportunityIds})` is safe (column ref, not a JS array).
