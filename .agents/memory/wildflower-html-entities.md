---
name: wildflower email/calendar HTML entities
description: Why Gmail/Airtable-sourced text shows literal HTML entities and how the CRM frontend handles it
---

# Email/calendar text arrives HTML-escaped

Gmail API fields (`email_messages.snippet`, `subject`, `body_text`) and Google
Calendar `description` come in HTML-escaped (`&#39;`, `&lt;`, `&gt;`, `&quot;`,
`&amp;`). The Airtable import preserved that escaping, so the DB stores the
literal entities (tens of thousands of rows — `snippet` is the worst). React
renders strings verbatim, so any component that prints these fields shows
`It&#39;s` instead of `It's`.

**Rule:** any frontend surface that renders Gmail- or Calendar-sourced free
text must pass it through `decodeHtmlEntities()` (in
`artifacts/wildflower-crm/src/lib/format.ts`). It is safe — output is rendered
as React text nodes, never `dangerouslySetInnerHTML`, so decoded `<...>` stays
inert.

**Why:** the escaping originates at the data source (Gmail) and recurs on every
sync/import, so a one-time data cleanup would regress. Decode at render instead.

**How to apply:** when adding a new view that shows email subject/snippet/body
or calendar summary/description, wrap those fields. Do NOT decode user-authored
content (notes, tasks, meeting notes) — those are typed in-app, contain no
entities, and decoding could mangle a literal `&amp;` the user typed.
`email-detail-dialog` renders `bodyHtml` in a sandboxed iframe, where the
browser already decodes — only its plain-text `bodyText`/`subject`/`aiSummary`
need the helper. Note `activity-timeline.tsx` is dead code (not imported).
