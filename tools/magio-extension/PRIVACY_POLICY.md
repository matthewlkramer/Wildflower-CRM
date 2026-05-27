# Privacy Policy — Wildflower Foundation CRM Extension

_Last updated: May 27, 2026_

Publish this at **https://wildflowerschools.org/privacy-extension** before submitting the extension to the Chrome Web Store. The URL must be reachable publicly (no login wall) for Google's review.

---

## Who this policy covers

This policy describes how the **Wildflower Foundation CRM** Chrome extension ("the Extension") handles information. The Extension is provided by Wildflower Schools for the sole use of its fundraising staff and is distributed via Google Workspace admin policy to `@wildflowerschools.org` accounts only. It is not available to the general public.

## What the Extension does

When a Wildflower staff member sends an email from Gmail with the Extension enabled, the Extension inserts a small invisible image ("tracking pixel") into the outbound message. When the recipient's email client loads that image, the Extension's backend records that the message was opened. Those open events are surfaced inside the Wildflower Fundraising CRM and linked to the matching contact record.

## What information is collected

For each tracked email sent by a Wildflower staff member, the Extension transmits to the Wildflower CRM backend:

- The sender's Wildflower email address.
- The recipient email address(es) on the message.
- The message subject line.
- The timestamp the message was sent.

For each open event, the backend records:

- The timestamp of the open.
- The IP address that loaded the tracking pixel (used to approximate location and to filter out the sender's own previews).
- The user-agent string of the device that loaded the pixel.

The Extension does **not** read, transmit, or store the body of any email message. It does not read any other Gmail content. It does not transmit any data to third parties.

## How the information is used

The collected information is used solely to:

1. Show Wildflower staff which donors and prospects have opened fundraising emails.
2. Link those engagement events to the corresponding contact record in the Wildflower Fundraising CRM.
3. Filter out self-opens and email-provider prefetches so the data reflects genuine recipient engagement.

## Where the information is stored

All data is stored on infrastructure controlled by Wildflower Schools (currently a managed PostgreSQL database accessed only by the Wildflower CRM API server). No data is shared with or transmitted to any third-party analytics, advertising, or data-broker service.

## Data retention

Tracking records and open events are retained for the lifetime of the related contact record in the Wildflower Fundraising CRM, and may be deleted at any time by a Wildflower administrator on request.

## Who has access

Only authenticated Wildflower staff users with access to the Wildflower Fundraising CRM can view the collected data.

## Recipients' rights

Recipients of email sent by Wildflower staff are not direct users of this Extension. If you are an email recipient and would like Wildflower Schools to delete tracking records associated with your email address, contact `privacy@wildflowerschools.org` (replace with the correct internal address before publishing).

## Children's data

The Extension is not intended for use by, and is not used to track, individuals under 13 years of age.

## Changes to this policy

This policy may be updated to reflect changes in the Extension's behavior. The "Last updated" date at the top will be revised accordingly.

## Contact

Wildflower Schools — `privacy@wildflowerschools.org` (replace with the correct internal address before publishing).
