# Email Intelligence — A Plain-English Walkthrough

This document explains how the CRM's "email intelligence" feature works,
from the moment an email lands in a fundraiser's Gmail inbox to the
moment a change is applied to a contact's record in the CRM. It is
written for a non-technical reader. You should be able to read it
top-to-bottom, understand what happens at each step and why, and
annotate or edit it later.

For each stage we note **where the code lives** so an engineer can find
it, but you don't need to read code to follow along.

---

## The big picture in one paragraph

Each fundraiser connects their Gmail. In the background, the CRM reads
their mail, figures out which messages involve people or organizations
already in the CRM, and quietly watches for a handful of useful "signals"
— things like "this person changed jobs," "this email address is dead,"
or "here's a new grant deadline." When it spots a signal, it writes down
a **proposal**: a suggested change for a human to review. An AI then
drafts the specific edits that proposal would make ("add this phone
number," "create this grant opportunity"). A fundraiser opens the review
queue, looks at each proposal, and clicks **Accept** (apply the change)
or **Dismiss** (ignore it). Nothing touches a real contact record until a
human says yes.

---

## Key terms (glossary)

- **Mailbox owner** — the fundraiser whose Gmail is connected. Everything
  is scoped per-owner; one person never sees another person's email
  signals.
- **Match** — the act of checking an email's participants against the
  CRM. A message is *matched* if at least one sender/recipient is a
  person, funder, or household already on file.
- **Signal** — a meaningful pattern detected in an email (a job change, a
  bounce, a grant deadline, etc.). Signals are the raw observations.
- **Proposal** — a saved, reviewable item created from a signal. It says
  "here's something we noticed; do you want to act on it?" Proposals live
  in the `email_proposals` table.
- **Dedupe key** — a short text fingerprint that identifies "the same
  proposal." If the same signal shows up twice (e.g. the same grant in two
  weekly newsletters), both map to the same dedupe key and only one
  pending proposal is kept.
- **Proposed action** — the concrete CRM edit(s) an AI drafts for a
  proposal (e.g. "mark this email invalid"). Stored on the proposal until
  someone accepts.
- **Status lifecycle** — where a proposal is in its life:
  `pending` → `applied` / `rejected` / `ignored` (explained below).

---

## The status lifecycle of a proposal

Every proposal moves through these states:

```
                 ┌──────────► applied   (a human accepted; changes were made)
                 │
   pending ──────┼──────────► rejected  (a human dismissed it as wrong/noise)
   (in the       │
    review       └──────────► ignored   (set aside — either auto-suppressed
    queue)                               as noise by the AI, or "right but
                                         not now")
```

- **pending** — freshly created, sitting in the review queue waiting for a
  human.
- **applied** — a fundraiser clicked Accept and the underlying CRM change
  succeeded.
- **rejected** — a fundraiser clicked Dismiss ("this was wrong").
- **ignored** — set aside without acting. The AI can auto-set this when it
  judges a proposal to be pure noise (see "AI drafts the actions" below);
  it also represents "correct, but I don't want to act now."

Proposals are **never deleted** — once resolved they stay as an audit
trail. A neat detail: the uniqueness rule that prevents duplicates only
applies to *pending* proposals. So once you resolve a proposal, an
identical signal months later (e.g. a fresh bounce, or another job move)
can surface again as a brand-new pending item instead of being silently
swallowed.

*(Defined in `lib/db/src/schema/_enums.ts` and `lib/db/src/schema/emailProposals.ts`.)*

---

## The signal categories

The pipeline watches for six kinds of signal. Each becomes a proposal of
a matching "kind":

1. **LinkedIn job changes** (`linkedin_job_change`) — LinkedIn
   notification digests ("Congratulate Jane on her new role at Acme") are
   parsed for people-who-changed-jobs. Only surfaced for people already in
   the CRM.
2. **Bounces** (`bounce_invalid` for hard bounces, `bounce_soft` for
   temporary ones) — "mailer-daemon" failure messages tell us an address
   is dead or temporarily failing. Only acted on for addresses already on
   file.
3. **Grant opportunities** (`grant_opportunity`) — grant/RFP newsletters
   and digests are mined for individual funding opportunities (title,
   funder, deadline, amount, link).
4. **Auto-responder moves** (`auto_responder_move`) — "I no longer work at
   X / I've moved to Y" auto-replies that indicate a genuine job move
   (plain out-of-office vacation replies are filtered out).
5. **Signature drift** (`signature_update`) — the signature block at the
   bottom of an inbound reply is parsed for a title/company/phone that
   differs from what the CRM currently has.
6. **Thank-you acknowledgments** (`thank_you_acknowledgment`) — this one
   is *outbound*: when the fundraiser sends a "thank you" email with a
   document attached to a funder contact shortly after a gift, we propose
   linking that email as the gift's thank-you record.

*(Detection logic lives in `artifacts/api-server/src/lib/intelDetectors.ts`
and is wired up in `artifacts/api-server/src/lib/emailIntelligence.ts`.)*

---

## The end-to-end flow, in order

### Stage 1 — Gmail sync / ingestion

**What it does:** reads the fundraiser's mailbox in the background and
decides which messages to keep.

There are two modes:

- **Bootstrap** — the first time a mailbox is connected, the CRM pages
  through the *entire* mailbox history (Gmail automatically excludes Spam
  and Trash). This is intentionally exhaustive because the contact
  timeline needs the full email history. It runs in capped batches so a
  single run can't hog the worker, remembering where it left off.
- **Incremental** — once the full sweep is done, the CRM only fetches what
  changed since last time, using Gmail's history feed. If Gmail has
  expired the history marker, it safely falls back to re-bootstrapping.

**The per-message pipeline:** for each new message the sync does the
following, cheaply, in order:

1. Skip it instantly if we've already stored or already skipped it.
2. Fetch just the headers first (From/To/Cc/Bcc/Subject/Date) — cheap.
3. Run the **match** (Stage 2) on the participants.
4. Decide what to do based on whether it matched (Stages 3+).

**Why it's careful:** if a message fails for a transient reason (network
blip, Gmail 5xx), the sync does *not* advance its bookmark, so the next
run retries exactly the failures and nothing is lost or double-counted.

There's also a **privacy mode**. If the mailbox owner has chosen
"summary only," the CRM never stores email bodies or runs body-based
intelligence — it just keeps a short AI summary. In that mode the signal
detection below is skipped entirely.

*(Code: `artifacts/api-server/src/lib/gmailSync.ts`. The low-level Gmail
API calls live in `artifacts/api-server/src/lib/gmail.ts`.)*

### Stage 2 — Matching

**What it does:** answers "does this email involve anyone we know?"

It takes all the addresses on the message, throws away the mailbox owner's
own address and any internal `@wildflowerschools.org` colleagues (staff
chatter shouldn't pollute donor timelines), then looks up the rest:

- direct address matches against the CRM's `emails` table (people,
  funders, households), and
- **domain** matches against known funder domains — so mail from a new,
  not-yet-added person at a known funder organization still threads onto
  that funder.

If anything matches, the message takes the **matched path**; if nothing
matches, it takes the **unmatched path**.

*(Code: `artifacts/api-server/src/lib/emailMatcher.ts`.)*

### Stage 3 — Signal detection

This is the heart of the feature, and it differs by path.

**Matched path** (the sender/recipient is someone we know):

- We only mine **inbound** replies (a signature only means something when
  it's *from* the contact, not *to* them).
- We skip internal teammate-to-teammate mail entirely.
- We then run the relevant detectors: grant digests, auto-responder
  moves, and signature drift. Signature parsing is carefully attributed to
  the *actual sender* (not just anyone on the thread) and has several
  guards to avoid grabbing a quoted reply's signature or the mailbox
  owner's own.

**Unmatched path** (nobody on the message is in the CRM):

- Most unmatched mail is just skipped (its metadata is recorded so it can
  be "promoted" later if a matching contact is ever added).
- **But** a few senders carry signal even though they aren't contacts —
  LinkedIn notifications, mailer-daemon bounces, and grant newsletters.
  Only for those specific sender/subject patterns do we pay the extra cost
  of fetching the full body. This decision is the "match gate" /
  `shouldFetchFullForIntel` check.

**Outbound path** (mail the fundraiser sent): used only for the thank-you
acknowledgment detector.

The detectors themselves are pure text-parsing (no database, no network),
which keeps them easy to test. They deliberately err toward returning
"nothing found" when a pattern is ambiguous, because a missed signal is
worse than a false alarm that a human can dismiss in one click.

*(Detectors: `artifacts/api-server/src/lib/intelDetectors.ts`.
Orchestration: `artifacts/api-server/src/lib/emailIntelligence.ts`.)*

### Stage 4 — Proposal storage & dedupe

**What it does:** turns a detected signal into a saved, reviewable
proposal — without creating duplicates.

Each detector builds a **dedupe key** that captures "what makes this the
same proposal":

- LinkedIn job change → person name + new company.
- Hard bounce → the bad address (one pending proposal per address).
- Soft bounce → address + month (so repeated transient failures
  accumulate as distinct monthly signals).
- Grant opportunity → the application link's host+path when available
  (most stable across newsletter copies), otherwise funder + deadline +
  title, with a content hash as a tiebreaker for vague ones.
- Auto-responder move → sender address + a fingerprint of the move
  details.
- Thank-you → gift id + the message.

The proposal is then written with an **upsert** that does nothing if a
*pending* proposal with the same (owner + dedupe key) already exists. So
the same grant arriving in three newsletters lands once. The proposal
also records hints about who/what it's about (target person, funder, or
email), and a `payload` of the parsed details for the review card.

*(Code: the `upsertProposal` helper in
`artifacts/api-server/src/lib/emailIntelligence.ts`; table definition in
`lib/db/src/schema/emailProposals.ts`.)*

### Stage 5 — AI drafts the actions

**What it does:** for each newly created proposal, an AI assistant drafts
the *specific* CRM edits a reviewer should consider.

A raw signal ("Jane is now at Acme") isn't directly actionable — should we
add a role? create the org? update a title? This step asks Claude, given
the signal plus the relevant CRM context (the person's current emails,
phones, and roles; candidate matching funders/orgs), to return a list of
**proposed actions** from a fixed, closed menu. Examples of that menu:

- add/retire a person's role at an organization,
- create a person and/or organization/funder and attach a role,
- add an email or phone, set a primary email,
- mark an email invalid (for bounces),
- create a grant opportunity,
- update a role's title.

Because the menu is fixed, the AI can't invent arbitrary database
operations. It can also return an **empty list** ("worth surfacing, but
nothing to auto-change"), or flag the whole thing as **noise to
suppress** — in which case the system auto-sets the proposal to `ignored`
so a human never has to triage it (but only when there are no concrete
actions to apply).

Two deterministic clean-up steps run after the AI:

- **Reconciliation** — if the AI proposes creating an organization that
  actually already exists (especially a *funder* it couldn't see), the
  system rewrites the action to link the existing entity instead of
  creating a duplicate. Funder-looking names become a reviewable
  "create new funder" suggestion rather than a stray organization.
- **Deadline guard** — any grant opportunity whose deadline has already
  passed is dropped, regardless of what the AI said.

This runs as fire-and-forget right after the proposal is created (so
actions are usually ready by the time someone opens the queue), with a
catch-up sweep for older proposals (see "Backfill"). It's idempotent —
running it twice won't re-spend AI tokens. Any failure is recorded on the
proposal row itself and never breaks the sync.

*(Code: `artifacts/api-server/src/lib/proposeActions.ts`.)*

### Stage 6 — The API / review queue

**What it does:** serves the proposals to the frontend and handles
Accept/Dismiss.

The API is strictly per-mailbox-owner: you can only see and act on your
own proposals (they contain private email content). Key endpoints:

- **List** pending proposals (filterable by kind, status, or the person/
  funder they're about).
- **Summary** counts (used for the dashboard badges).
- **Accept** — atomically claims the proposal (flips `pending` →
  `applied`) and runs all its proposed actions inside a single
  transaction. If *any* action fails, the whole thing rolls back and the
  proposal stays pending, so you never get a half-applied change. Accepting
  is idempotent: re-clicking after a network hiccup won't double-apply.
- **Reject** — flips `pending` → `rejected`.

Both Accept and Reject can carry an optional free-text "reviewer note"
used later for tuning the AI.

*(Code: `artifacts/api-server/src/routes/emailProposals.ts`.)*

### Stage 7 — Frontend review

**What it does:** the screen where fundraisers actually triage signals.

It's a tabbed page — one tab per signal category, plus a "New
correspondents" tab. Each proposal renders as a card showing the parsed
details, when the email was sent, links to view the person or the original
email, and a clear **"On accept, the following will happen:"** list of the
AI-drafted actions. Accept and Dismiss each open a small dialog for an
optional note before confirming. After acting, the relevant lists refresh
so counts and badges stay current.

*(Code: `artifacts/wildflower-crm/src/pages/email-intelligence.tsx` and
`artifacts/wildflower-crm/src/components/EmailProposalsCard.tsx`.)*

### Stage 8 — Applying the actions

**What it does:** performs the real CRM edits when a proposal is accepted.

Each action is dispatched to a dedicated handler that:

- **re-validates IDs at apply time** — entities may have been deleted
  between when the proposal was drafted and when it's accepted, so a stale
  plan fails loudly instead of corrupting data;
- **avoids duplicates** — e.g. adding an email that already exists, or a
  role that already exists, is skipped with an explanation rather than
  duplicated;
- runs inside the Accept transaction, so a failure aborts everything.

The result is a per-action report ("applied / skipped / failed" with a
message) that the frontend can show.

*(Code: `artifacts/api-server/src/lib/applyProposalActions.ts`.)*

---

## Backfill — catching up old mail

When new detectors or matching rules ship *after* a mailbox was already
synced, a one-time **backfill** re-runs the pipeline over stored mail so
users get the benefit retroactively. It runs in four phases under the
same lock as the normal sync:

- **Phase A** — re-check previously skipped messages; if someone is now in
  the CRM, promote the message to a stored, matched message (and run
  matched-path intel on it).
- **Phase B** — re-run matched-path detectors over already-stored bodies
  (no Gmail call needed) so new detectors pick up historical signals.
- **Phase C** — re-run unmatched-path detection on still-skipped messages
  whose sender/subject passes the match gate (LinkedIn/bounce/grant).
- **Phase D** — draft AI actions for any pending proposals that don't have
  them yet.

It's idempotent and skips the body-mining phases entirely in
"summary only" privacy mode.

*(Code: `artifacts/api-server/src/lib/gmailBackfill.ts`.)*

---

## Quick file map

| Stage | What | File |
|------|------|------|
| 1 | Gmail sync / ingestion | `artifacts/api-server/src/lib/gmailSync.ts` |
| 2 | Matching | `artifacts/api-server/src/lib/emailMatcher.ts` |
| 3 | Signal detection (pure parsers) | `artifacts/api-server/src/lib/intelDetectors.ts` |
| 3/4 | Detector orchestration + proposal upsert | `artifacts/api-server/src/lib/emailIntelligence.ts` |
| 5 | AI-drafted actions | `artifacts/api-server/src/lib/proposeActions.ts` |
| 6 | Review-queue API (list/accept/reject) | `artifacts/api-server/src/routes/emailProposals.ts` |
| 7 | Frontend review page | `artifacts/wildflower-crm/src/pages/email-intelligence.tsx` |
| 7 | Frontend dashboard card | `artifacts/wildflower-crm/src/components/EmailProposalsCard.tsx` |
| 8 | Applying accepted actions | `artifacts/api-server/src/lib/applyProposalActions.ts` |
| — | Catch-up backfill | `artifacts/api-server/src/lib/gmailBackfill.ts` |
| — | Proposal table + lifecycle | `lib/db/src/schema/emailProposals.ts`, `lib/db/src/schema/_enums.ts` |
