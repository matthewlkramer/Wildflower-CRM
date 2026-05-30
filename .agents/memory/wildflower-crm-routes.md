---
name: wildflower-crm detail page routes
description: Non-obvious route naming for record detail pages (matters when navigating/testing)
---

# Wildflower CRM record detail routes

The funders entity is routed under **`/funding-entities`** (list) and
`/funding-entities/:id` (detail), NOT `/funders`. Navigating to `/funders`
yields the 404 NotFound page.

Other detail routes match their plural noun: `/individuals/:id`,
`/households/:id`, `/opportunities/:id`, `/gifts/:id`, `/pledges/:id`
(pledge detail inherits the opportunity detail component).

**Why:** the term "funder" is used in UI/highlights but the route segment is
"funding-entities". An e2e test plan that assumed `/funders` 404'd.

**How to apply:** when writing test plans or links to the funder detail page,
use `/funding-entities/:id`.
