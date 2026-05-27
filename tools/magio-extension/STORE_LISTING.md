# Chrome Web Store listing copy — Wildflower Foundation CRM

Use this when uploading the extension to chrome.google.com/webstore/devconsole. Set **Visibility = Unlisted** so it doesn't appear in public search but can still be force-installed by ID from Google Admin.

## Required fields

**Name** (max 75 chars)
Wildflower Foundation CRM

**Summary** (max 132 chars)
Wildflower Foundation CRM extension tool. Tracks email opens in Gmail and links them to contacts in the Wildflower Fundraising CRM.

**Description** (max 16,000 chars)
The Wildflower Foundation CRM extension tracks when email recipients open messages you send from Gmail, and links those opens back to the matching person, household, or funder record in the Wildflower Fundraising CRM.

Features:
- Automatically inserts an invisible tracking pixel into outbound Gmail messages sent by your account.
- Records open events (timestamp, approximate location, device) on the Wildflower CRM so fundraising staff can see engagement at a glance.
- Auto-matches each tracked email to existing CRM contacts by recipient address — no manual linking required.
- Suppresses self-opens (the sender previewing their own message) and opens within 5 minutes of send (Gmail's own image-prefetch).

This extension is intended only for internal use by Wildflower Schools fundraising staff using `@wildflowerschools.org` Google Workspace accounts. It is distributed as an Unlisted item and installed via Google Workspace admin policy.

Source code: https://github.com/DeepakSilaych/Magio (MIT) — Wildflower-specific fork is maintained internally.

**Category**
Workflow & Planning

**Language**
English (United States)

## Single-purpose justification (required for Gmail-scope extensions)
The extension has a single purpose: to track email-open events for messages sent from the user's Gmail account and forward those events to the Wildflower Fundraising CRM. All other functionality (popup status indicators, recent-send list) exists only to surface that tracking data to the same user.

## Permission justifications

- **storage** — caches the user's CRM API base URL and last-known list of recent tracked sends locally so the popup loads instantly.
- **host_permissions: https://mail.google.com/** — required to inject the tracking pixel and the small "tracked" indicator into Gmail's compose window and Sent folder.
- **host_permissions: https://*.replit.app/, https://*.replit.dev/, http://localhost:* ** — required to POST tracking records to the Wildflower CRM API server. Update this list (and re-publish) once the CRM is on a permanent custom domain.

## Privacy policy URL
https://wildflowerschools.org/privacy-extension

## Screenshots
You'll need 1–5 screenshots, each 1280×800 or 640×400 PNG/JPEG. Suggested shots:
1. Gmail compose window with the "Tracked" badge visible.
2. Extension popup showing the recent sends list.
3. Wildflower CRM `/email-tracking` page showing the KPI tiles and recent-sends table.
4. A tracked-email detail dialog with the linked contact backlink.

## Promotional tile (required)
440×280 PNG. Simple Wildflower green background + extension name + small icon is fine.

## Review notes (optional text box for Google reviewers)
This is an Unlisted, internal-only fundraising extension for Wildflower Schools (~10 users on `@wildflowerschools.org` Workspace accounts). It is force-installed via Google Workspace admin policy, not distributed to the public. All open-tracking data flows only to Wildflower-controlled infrastructure (the CRM API server). No data is shared with third parties.
