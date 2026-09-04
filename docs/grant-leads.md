---
status: ratified
last_verified: 2026-09-04
---

# Grant Leads

Grant Leads is a focused discovery queue for open external funding
opportunities that are not yet represented in the CRM. It is not a general
email-newsletter feed.

## Inclusion rule

An email item qualifies only when it affirmatively announces an open funding
opportunity: an application/LOI/RFP is open, funding is available with an
application or eligibility detail, or a grant amount is paired with an
application/deadline signal.

Exclude shopping and event promotions, articles and product updates, RFP
templates/guides, procurement solicitations where the sender is hiring a
vendor, application decisions, winner announcements without a new open round,
past explicit deadlines, image/link fragments, and quoted reply tails.

## Identity and provenance

- One row represents one named funding program, not one email paragraph or
  announcement.
- Re-announcements, reminders, and copies from different external sources are
  grouped under that row. Deadline wording, tracking URLs, and newsletter
  subject changes do not create a new lead.
- Each contributing email remains a `grant_lead_sightings` child record and is
  shown as an expandable source-email list on the lead.
- A stable destination URL is the fallback identity when no named program can
  be extracted. Tracking, redirect, and asset URLs are never identities.
- Existing CRM opportunities are still a human review concern at conversion;
  this queue's machine filter establishes that the email is a real open
  opportunity, not that Wildflower definitely has no related record.

The extractor is deterministic code in `intelDetectors.ts` and
`grantLeadIdentity.ts`. The admin-editable email intelligence prompts generate
legacy `email_proposals`; they do not generate `grant_leads`.

## Display headline

The source subject/extracted title remains stored as provenance and as the
default name when a reviewer converts a lead. The headline beside the
lightbulb is instead `grant_leads.ai_summary`: a one-sentence AI summary of the
opportunity's purpose, eligibility, amount, and deadline using only facts that
the extractor captured. It explicitly names the known funder and named program
(or whichever of those is available), so a generic phrase such as "a funding
opportunity" never replaces the opportunity's identity. New leads are
summarized asynchronously. A versioned, bounded
background sweep fills older or temporarily failed rows; while it is pending,
the list says that the opportunity summary is being generated rather than
falling back to an email subject.
