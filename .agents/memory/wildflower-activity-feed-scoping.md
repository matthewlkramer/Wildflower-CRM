---
name: wildflower-crm unified activity feed scoping
description: Why notes/tasks scope must be separated from donor-relationship scope in the record-detail activity feed
---

# Unified activity feed scoping (record detail pages)

The center lane of every record detail page is a single merged feed
(`UnifiedActivityFeed`) combining 7 sources: notes, tasks, interactions,
email, calendar, meeting notes, and email-intelligence proposals.

Two scopes must be kept SEPARATE on the component:

- **Relationship scope** (`personId`/`funderId`/`householdId`) — drives
  interactions/email/calendar/meetings/intel. These sources only ever link
  to a person, funder, or household, never to an opportunity or gift.
- **Notes/tasks scope** (`notesContext`) — drives notes + tasks, which DO
  link to opportunities/gifts as well.

On opportunity and gift pages these differ: activity is scoped to the
**donor** (the linked funder/person/household), while notes/tasks link to the
opportunity/gift itself. So those pages pass donor IDs as the relationship
scope AND `notesContext={{ opportunityId }}` / `{{ giftId }}`.

**Why:** the API list endpoints (e.g. notes/tasks routes) combine every
filter with `and(...)` (each is a `@> ARRAY[...]` slug-array contains check).
Passing donor `funderId` + `opportunityId` together would require a row
matched to BOTH and return nothing. Keeping the scopes separate avoids this.

**How to apply:** never collapse the relationship scope and the note/task
scope into one set of props. Relationship-only source queries are gated with
`enabled: relationScoped` (and proposals with `enabled: proposalsEnabled`) so
opportunity/gift pages don't fire global list fetches. ThankYouPanel (gift)
belongs in the RIGHT lane, not stacked in the center feed lane.
