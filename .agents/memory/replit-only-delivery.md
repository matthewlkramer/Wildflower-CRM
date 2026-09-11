---
name: Fundraising CRM uses Replit-only delivery
description: Ignore Vercel checks and previews; reconcile the Replit checkout with GitHub before using Replit Republish.
---

# Fundraising CRM uses Replit-only delivery

Vercel is not part of the Wildflower Fundraising CRM's supported build,
preview, review, or production path. A Vercel status check on a GitHub pull
request is irrelevant to release readiness and should not be monitored or
reported as a CRM deployment signal.

GitHub is the code source of truth and Replit owns the running deployment. Once
the intended commits have been pushed, ask the Replit Agent to reconcile the
Replit-local checkout with GitHub before publishing. It must inspect both sides,
preserve legitimate Replit-local work, incorporate the intended Git commits,
resolve conflicts deliberately, and verify the resulting checkout rather than
blindly overwriting either side.

Only after that consolidation and verification should Replit's **Republish**
flow be used. Verify the live application at `wfcrm.replit.app`; do not use a
Vercel preview URL as evidence.
