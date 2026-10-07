---
status: current-status
last_verified: 2026-10-07
---

# Personal dashboard

Customize dashboard lets each signed-in user hide and restore cards. Visibility is stored per CRM user ID in this browser's local storage; it is not synchronized between devices. Hidden standalone cards are unmounted, so their card-specific queries do not run; the shared dashboard summary still supplies the fiscal-year heading. New accounts retain all cards by default. Data cleanup and integrity is the former Worklists card; its contents and API-owned counts are unchanged.

Past meeting follow-ups considers the user's 50 most recent CRM-matched calendar events within the last 60 days. It respects the existing no-notes-needed dismissal, excludes cancelled and still-running meetings, and uses the API's `hasMeetingNotes` and `hasNextSteps` flags. It highlights missing notes or missing next steps, not task-completion status. The link to Meetings opens the full work queue.

Gifts needing thank-yous lists the viewer's ten most recent active gifts with no recorded thank-you sent date, using the existing owner and thank-you presence filters and the global entity scope. The recorded sent date remains authoritative; this card does not infer acknowledgements from attachments or email content.
