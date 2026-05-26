# Wildflower CRM — Competitive Review & Roadmap

A look at what Salesforce (Sales Cloud + Nonprofit Cloud), Copper, and HubSpot
do well in 2025–2026, and where Wildflower CRM has room to grow. The goal is
**not** feature parity with a generalist CRM — Wildflower is a purpose-built
fundraising tool — but to steal the best ideas from each.

---

## 1. Where Wildflower CRM stands today

What we already have that holds up well against the big three:

| Capability | Status |
| --- | --- |
| Domain model (funders, people, households, opportunities/pledges, gifts, allocations) | Strong — purpose-built, matches how Wildflower actually fundraises |
| Pipeline / Kanban view of opportunities | ✅ `/pipeline` |
| Fiscal-year-aware projections + dashboard | ✅ `/projections`, `/dashboard`, `/fiscal-year/:fy` |
| Grants calendar | ✅ `/grants-calendar` |
| Multi-entity (multi-fund) accounting baked into the schema | ✅ — most generalist CRMs bolt this on later |
| Donor xor (funder / individual / household) enforced in DB + API | ✅ — cleaner than Salesforce's NPSP "Account model" workarounds |
| Gmail + Calendar two-way sync, per-user OAuth | ✅ |
| Email intelligence (LinkedIn job changes, bounces, auto-responder moves, signature drift, grant digests, unrecognized correspondents) — proposal review queue | ✅ — this is genuinely ahead of Copper/HubSpot's stock features |
| Clerk auth, Google SSO restricted to org domain | ✅ |
| Generated typed API client + Zod validators from OpenAPI | ✅ |

Pages: dashboard · individuals · households · funding-entities · pipeline ·
opportunities · pledges · gifts · moves · interactions · projections ·
fiscal-year detail · grants-calendar · email-intelligence · settings · admin.

API surface: 30+ REST resources, analytics endpoints, Google OAuth + sync,
email proposals + correspondents review.

---

## 2. What the competition does well

### Salesforce (Sales Cloud + Nonprofit Cloud)

The platform-of-record for big organizations. They migrated from the
"NPSP managed package" to a native Nonprofit Cloud on Lightning in 2024.

**Strengths worth borrowing**
- **Activity Timeline** — single vertical, chronological feed on every record
  (emails, calls, meetings, tasks, file uploads, internal notes). The "spine"
  of the record page, not a tab.
- **Path & Guidance** — chevron-style stage bar across the top of an
  opportunity, with role-specific tips at each stage ("at this stage,
  schedule a discovery call, attach the case for support, …").
- **Lightning App Builder** — admins drag-and-drop record-page components,
  so different roles see different views of the same data.
- **Gift Entry Manager (GEM)** — batch high-volume gift entry with running
  totals, auto soft-credit, and validation before commit. The "data entry
  power tool" most fundraisers actually live in.
- **Advanced forecasting** — multi-dimensional (region × fund × period × stage)
  with confidence ranges.
- **Einstein Relationship Insights** — auto-discovered connections between
  prospects and existing donors/board (news + social + internal data).
- **Agentforce (2025)** — autonomous agents that can triage donor inquiries
  and qualify leads without manual triggering.
- **NCOA integration** — automated address cleanup against the USPS
  National Change of Address database.

### Copper CRM

Built exclusively for Google Workspace shops. The "zero-entry" philosophy.

**Strengths worth borrowing**
- **Lives inside Gmail/Calendar as a side panel** — users almost never visit
  the CRM web app. Compose-time and read-time enrichment, log-as-you-go.
- **Auto-enrichment** — pulls socials, company info, photo from email address
  alone (Clearbit-style).
- **Relationship Strength Meter** — scores each contact's "health" from email
  frequency + response rate + recency. Surfaces "going cold" warnings.
- **Stale-record indicators on the Kanban** — visual cue when an opportunity
  hasn't been touched in N days.
- **Bi-directional inbox sync without BCC tricks** — every thread is captured
  automatically, including replies that happen days later.
- **Chrome extension for LinkedIn** — one-click add-from-LinkedIn into the
  CRM, with auto-mapped fields.
- **Copper AI (2024)** — drafts follow-up emails using thread history;
  summarizes long correspondence into a few bullets.

### HubSpot CRM

The "all-in-one" — CRM, marketing, CMS, payments, AI in one cohesive UI.

**Strengths worth borrowing**
- **Universal command palette (⌘K)** — instantly find any record, action,
  page, report, or help article. Replaces nav for power users.
- **Object Creator wizard** — non-engineers can create new entity types
  (e.g. "Scholarship", "Site Visit", "Volunteer") with custom fields, list
  views, and detail pages, no schema migration required.
- **Dashboard library** — hundreds of pre-built reporting widgets you can
  drop on a dashboard without writing SQL.
- **Sequences** — automated email cadences that pause the moment the
  recipient replies. Critical for cultivation.
- **Lead Scoring 2.0** — ML-based predictions of "most likely to convert" /
  "most likely to give" based on behavioral signals.
- **Breeze AI agents (2024)** — content drafting, prospecting, enrichment
  baked across the platform — not a separate page.
- **Native payment links** — generate a donation link that auto-creates a
  contact and a deal record on payment.

---

## 3. Where we're behind — gap analysis

Areas where one or more competitors clearly does better than we do today.
Some are quick wins, others are big bets.

### High-impact gaps

1. **No unified activity timeline on detail pages.** Today individual /
   funder / opportunity detail pages have separate "Interactions",
   "Emails", "Calendar Events" sections. Every competitor surfaces a single
   chronological stream as the centerpiece of the record. **This is probably
   the highest-ROI UI change we can make.**

2. **No stage-aware guidance on opportunities.** The pipeline shows stages,
   but there's no "at this stage you should…" coaching. Salesforce's Path
   component is the canonical pattern; fundraising teams especially benefit
   because moves-management has a clear playbook per stage.

3. **No relationship-health signal.** Copper's strength meter and HubSpot's
   "going cold" alerts are exactly the kind of thing a small fundraising
   team needs to keep a 200-prospect portfolio warm without manual tickling.
   We already have all the data we need (gmail sync + interactions).

4. **No batch gift entry tool.** When checks arrive in the mail, an analyst
   sits in front of the CRM for 30 minutes typing them one by one. GEM-style
   batch entry (paste / type a list, validate, commit all) would save real
   hours per week.

5. **No saved views or shareable lists.** Power users in HubSpot and
   Salesforce live inside "smart lists" / "list views" — saved filter +
   column configurations they can name, share, and pin. Our list pages
   (`/individuals`, `/funding-entities`, `/opportunities`) only have ad hoc
   filtering.

6. **No bulk actions on list pages.** Common operations (assign owner, add
   to a moves campaign, export, tag) all require visiting records one by
   one. Multi-select + bulk action is table-stakes elsewhere.

7. **No global command palette.** Hitting ⌘K and typing "Acme Foundation"
   to jump straight to that funder record (vs. nav → funding-entities →
   search → click) is one of those features users don't know they want
   until they have it.

### Medium-impact gaps

8. **Email composition stays in Gmail.** We read email signals beautifully
   (intelligence pipeline, signature drift, etc.), but writing donor email
   still means opening Gmail in another tab. Copper's in-CRM compose with
   contact context auto-filled is the bar.

9. **No email sequencing / cadences.** Cultivation calendars are exactly
   the kind of workflow HubSpot Sequences are built for: "after first
   meeting, send touch 1 in 3 days, touch 2 in 10 days, pause if they
   reply." We have grants-calendar (deadline-driven) but no
   cultivation-cadence concept.

10. **No relationship mapping / "who knows whom".** Salesforce's
    Relationship Insights and Copper's connection graph would let
    Wildflower staff answer "which of our board members knows someone at
    the Hewlett Foundation?" — gold for major-gifts work.

11. **No prospect research enrichment.** A funder record today only shows
    what's in our DB. Copper auto-pulls company size, location, social
    handles from public sources; we could do the same with one of the
    enrichment APIs (Clearbit, Apollo, or an OpenAI web-search agent).

12. **Reporting is fixed.** Dashboard tiles + projections + FY detail
    are useful but hardcoded. HubSpot's dashboard library and Salesforce's
    Lightning report builder let development directors answer their own
    questions without filing a ticket.

13. **No mobile-optimized view.** Major-gift officers do donor visits.
    Even a read-mostly mobile view of "today's interactions + the donor I'm
    about to meet" would be a huge unlock. Our layout breaks below ~768px.

### Lower-impact / specialty gaps

14. **No address standardization / NCOA.** Salesforce nonprofits get this
    for free; we'd need a USPS-licensed vendor (or skip if mail isn't
    central to Wildflower's work).

15. **No donation form / payment link.** HubSpot generates a payment URL
    that auto-creates the gift on completion. If Wildflower ever does
    public-facing campaigns, this matters; otherwise low priority.

16. **No custom-object creator.** Schema changes today are an engineering
    task. HubSpot's wizard isn't realistic for us short-term, but a
    lightweight "add a custom field to people / funders" admin would meet
    80% of the need.

17. **No AI assistant in-app.** We have email intelligence, but no "ask the
    CRM" agent (e.g. "summarize my last 5 interactions with the Walton
    Foundation"). The infrastructure (Gemini/OpenAI proxies) is already
    available.

---

## 4. Suggested roadmap

Ordered by **(impact to fundraisers) ÷ (engineering effort)**. The first
three are the items I'd ship next if you asked me to pick.

### Phase 1 — quick UX wins (1–2 sprints each)

1. **Unified activity timeline on detail pages.** Merge interactions +
   emails + calendar events + email-intelligence proposals into one
   chronological feed on individual / funder / household / opportunity
   detail pages. Keep the existing sections as filterable tabs above the
   feed. Backend already has all the data — this is mostly a frontend job.

2. **Global ⌘K command palette.** Search across people, funders,
   households, opportunities, gifts. Reuse existing list endpoints.

3. **Saved views on list pages.** Persist filter + column config per user.
   localStorage first, DB-backed (shareable) later.

4. **Bulk actions on list pages.** Multi-select rows → assign owner /
   export CSV / tag (once tags exist).

### Phase 2 — moves-management depth (1 sprint each)

5. **Stage Path component on opportunity detail.** Chevron stage bar +
   per-stage coaching text (admin-editable). High visual impact, modest
   work.

6. **Relationship-health score.** Compute from email frequency + response
   rate + days-since-last-touch (we already have all inputs). Surface as
   a badge on detail pages and a sortable column on lists. "Going cold"
   filter on the dashboard.

7. **Cultivation sequences (lightweight).** Define a named cadence
   ("Major gift first-touch"), assign to a person, get reminders. No
   auto-send in v1 — just the reminder/task layer.

### Phase 3 — power-user productivity (2–3 sprints each)

8. **Batch gift entry tool.** Single page: type/paste rows, validate
   donor matches inline, commit all in a transaction. Mirror GEM's
   ergonomics.

9. **Mobile-friendly detail views.** "Today's calls" + responsive
   individual / funder detail. PWA-style add-to-homescreen.

10. **Custom field admin.** Per-user `people.custom_data jsonb` plus a
    settings UI to define schema and surface fields on detail pages. Avoids
    a full custom-object system but covers 80% of real requests.

11. **Dashboard widget library.** Let users compose their own dashboard
    from a palette of pre-built tiles (gifts in FY, top-5 funders,
    overdue moves, relationship-health distribution, …). Pin per-user
    layout.

### Phase 4 — bigger bets (multi-sprint, evaluate first)

12. **AI in-app assistant.** "Summarize my history with this funder",
    "draft a follow-up to last week's meeting", "which board member knows
    someone at Hewlett?" — built on the existing AI integration proxy.

13. **Contact + funder enrichment.** Auto-pull employee count, website,
    socials, LinkedIn for funders and people. Decide on a vendor or
    build via OpenAI web-search agent.

14. **In-CRM email compose.** Replace "open Gmail" with a compose modal
    that logs against the contact automatically. Leverages existing
    Gmail OAuth.

15. **Relationship-map visualization.** Force-directed graph of
    connections (board → funders → people). Niche but a great
    major-gifts tool.

---

## 5. What we should explicitly NOT copy

A few things the big CRMs do that would be wrong for Wildflower:

- **Sprawling customization.** Salesforce's flexibility is also why
  every nonprofit needs a consultant. Our schema is purpose-built;
  resist the urge to turn it into a generic platform.
- **Marketing automation.** HubSpot's lead scoring and marketing hub
  assume inbound funnels. Major-gift fundraising is the opposite shape —
  a small number of high-touch, long-cycle relationships. Resist the
  pressure to add MQL/SQL concepts.
- **Pay-per-seat thinking baked into the product.** Our user base is
  small and trusted; we can skip role-based access complexity until
  someone actually asks for it.

---

## 6. Recommended next step

Pick from Phase 1. My single-best-bet recommendation is **#1 (unified
activity timeline)** — it makes the app dramatically more useful with the
data we already have, takes ~1 sprint, and sets up Phase 2's
relationship-health work because the timeline is where that signal
naturally surfaces.
