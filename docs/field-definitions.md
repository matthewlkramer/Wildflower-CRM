---
status: ratified
last_verified: 2026-09-12
---

# Donor fields and shared cleanup work

These definitions reflect the owner's field/schema decisions of September 12,
2026. They govern this implementation and future forms/imports.

| Field | Meaning and entry guidance |
| --- | --- |
| Priority | Staff's overall assessment of the best prospects for future giving, considering capacity, connection, enthusiasm, and organizational fit. It remains manual; supporting ratings are useful context, not duplicate versions of priority. |
| Potential annual giving to Wildflower | Estimated annual giving potential to Wildflower, using the existing capacity bands. Blank means not assessed. It is not net worth, lifetime giving, or an expected pledge. |
| Relationship owner | Staff member responsible for cultivating and coordinating the relationship. |
| Organization funding regions | Places the organization is interested in funding. Office location comes from Contact info addresses and must not populate this field. Blank means interests are unknown. |
| Person funding regions | Geographic funding interests, separate from current home region. |
| Display as Anonymous in CRM | Existing CRM name masking. This does not record a public recognition instruction or imply complete anonymity from authorized staff. |
| Organization email | Canonical rows in Contact info → Emails. The detail shortcut derives the preferred usable address, then the oldest usable address. There is no independently editable organization email. |
| Expected commitment date | Anticipated donor decision/commitment date, separate from payment timing and fiscal-year credit. |
| Committed amount / award ceiling | Relevant to a pledge or verbally confirmed commitment. Initial prospect forms do not ask for it. |
| Fiscal year credited | Fiscal year receiving fundraising credit on an allocation; review separately from the date money is expected. |

Allocation forms expose the project picker when intended use is Project, and
use named school choices. Pledge reimbursement prompts appear for reimbursement
awards or existing reimbursement values. Conditions-met prompts appear for
conditional commitments or existing values. Hidden controls preserve existing
data. Payment timing remains in the payment plan. These form changes do not
alter recognition, donor identity, money amounts, or lifecycle rules.

In Finance → Cash flow, standard one-time pipeline gifts use the
projected close date as a labeled receipt estimate unless an explicit payment
plan exists. Payment dates remain optional; the report shows the timing basis
instead of creating missing-date cleanup items. This derived estimate does not
change the stored meaning of commitment dates or fiscal-year credit. See
[funding-arrivals-current-status.md](funding-arrivals-current-status.md).

## Newsletter evidence and current status

`newsletter_preference_events` is authoritative. Each item preserves what
happened, the source/method, evidence text and optional source link, actual event
date if known, recording date, and the recording user where available. Imports
also retain stable source identities and minimal provenance metadata.

- Affirmative consent records an explicit opt-in. Audience membership alone
  is not consent. A missing date remains unknown.
- Staff additions select the person for the audience without asserting consent.
  Staff removal deselects the person without claiming the donor opted out.
- Opt-out evidence remains in history permanently through the application,
  including the date and method when available.
- Current opt-out wins over staff additions. Only affirmative consent with an
  actual date strictly later than the opt-out can lift suppression. Equal dates
  do not lift it. An undated opt-out uses its first observation as the conservative
  ordering boundary; undated consent cannot lift any opt-out.
- Audience selection follows the latest dated consent or staff selection/removal.
  Historical membership and undated consent are baseline evidence and do not
  override later staff decisions. Staff removal wins a same-time selection tie.
- The existing people flags are database-maintained projections used by filters
  and delivery sync, not editable consent facts. Person merges move all evidence
  and use the same derivation.

The form reports **Selected for newsletter**, **Not selected**, or **Opted out**,
plus whether any affirmative-consent and previous-opt-out evidence exists.
Selection is distinct from successful delivery: a usable email and the email
provider's delivery status also matter.

Fillout / SSJ answers are checked against the preserved form response. An exact
Yes is consent; an explicit No is a request not to receive communications and
is treated as opt-out evidence. Test/disputed records and conflicting identities
or answers are left for review. A record-update timestamp is not a consent date.
Flodesk's actual opt-in timestamp can establish dated consent; active audience
membership without that timestamp establishes membership only. Current Flodesk
unsubscribe status does not supply the original date or initiator, so those
remain unknown. Historical Flodesk/Mailchimp review is a separate open cleanup
project; the initial backfill does not claim that review is complete.

## Cleanup projects

The Cleanup Queue accepts standalone shared projects as well as flags on donor
and financial records. Add a project with a title and working notes; record the
next step, person responsible, follow-up date, and source links in those notes.
Use **Cleanup projects only** to find them among record-level flags. Existing
Open, Resolved, and Dismissed states govern the work; resolving an item records
who completed it and when. Read-only viewers can inspect but cannot change it.

The implementation seeds two open projects: historical newsletter evidence
(including Mailchimp opt-outs), and completion/review of the shared historical
donation-coding worksheet. Reapplying the seed preserves notes and completion.
