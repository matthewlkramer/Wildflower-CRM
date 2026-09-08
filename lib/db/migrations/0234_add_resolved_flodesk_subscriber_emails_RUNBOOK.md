# Runbook — resolved Flodesk subscriber emails

## Purpose

Migration 0234 adds 28 resolved or owner-confirmed Flodesk current-subscriber
addresses to existing CRM people, links the corresponding
`newsletter_contacts` and `newsletter_engagement` evidence, and applies the
owner-approved rule that current Flodesk subscribers are subscribed in the CRM.

It preserves all existing email preferences. A new address becomes preferred
only when its person has no other CRM email.

## Required order

Migration 0233 must be applied successfully before 0234. Migration 0234 checks
for the 0233 audit entry and aborts otherwise.

Run both from the Replit production shell, in order:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0233_reconcile_flodesk_subscription_statuses_and_philip_vasan_email.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0234_add_resolved_flodesk_subscriber_emails.sql
```

Expected 0234 success notice:

```text
NOTICE:  0234: verified 28 resolved emails, contacts, engagement links, and subscribed people
```

## Reviewed automatic matches

| Flodesk email | CRM person | Type | Validity |
|---|---|---|---|
| abeckner@imaginablefutures.com | Ashley Beckner | Work | Unknown |
| amy.gips@wildflowerschools.org | Amy Gips | Work | Unknown |
| aplancher@socialfinance.org | Annie Knickman Plancher | Work | Unknown |
| ccodellalow@bipartisanpolicy.org | Caitlin Codella Low | Work | Unknown |
| daniela.vasan@wildflowerschools.org | Daniela Vasan | Work | Unknown |
| erica.cantoni@wildflowerschools.org | Erica Cantoni | Work | Unknown |
| gregklein411@gmail.com | Greg Klein | Personal | Unknown |
| jmccormick@fmcg.com | Jim McCormick | Work | Unknown |
| jparadis@chappellculper.org | Jennifer Paradis | Work | Unknown |
| kgarg@schmidtfutures.com | Kumar Garg | Work | Unknown |
| maia.blankenship@wildflowerschools.org | Maia Blankenship | Work | Unknown |
| mbazan@arnoldfoundation.org | Marissa Bazan | Work | Unknown |
| mchun@hewlett.org | Marc Chun | Work | Unknown |
| mdukes@overdeck.org | Melanie Dukes | Work | Unknown |
| paul.keys@teachforamerica.org | Paul Keys | Work | Unknown |
| rachel.kelley-cohn@wildflowerschools.org | Rachel Kelley-Cohn | Work | Unknown |
| rjohnson@citybridge.org | Rena Johnson | Work | Unknown |
| sunny.greenberg@wildflowerschools.org | Sunny Greenberg | Work | Unknown |
| ted.quinn@covariantgroup.com | Ted Quinn | Work | Unknown |
| tiffany.needham@teachforamerica.org | Tiffany Cuellar Needham | Work | Unknown |
| maas@closegapsby5.org | Ericca Maas | Work | Unknown |
| jim@freyfoundationmn.org | Jim Frey | Work | Unknown |

The first 20 match a unique CRM person's first name plus a distinctive
first+last, first-initial+last, or surname pattern in the email address. Ericca
Maas has unique first-name and surname evidence. Jim Frey's address is also
corroborated by four historical messages whose populated person associations
all point to Jim.

## Owner-confirmed identities

| Flodesk email | CRM person | Type | Validity | Note |
|---|---|---|---|---|
| hassan@4pt0.org | Hassan Hassan | Work | Invalid | Owner confirmed the old-role address is no longer active. |
| scullyr@gmail.com | Bob Scully | Personal | Unknown | Owner confirmed identity. |
| brooke@chanzuckerberg.com | Brooke Stafford-Brizard | Work | Unknown | Owner confirmed identity; former role. |
| shavar@dfer.org | Shavar Jeffries | Work | Unknown | Owner confirmed identity; former role, now at KIPP. |
| john@arnoldfoundation.org | John Arnold | Work | Unknown | Owner confirmed identity. |
| lesrinivasan@gmail.com | LaVerne Srinivasan | Personal | Unknown | Owner confirmed identity; personal email remains independent of former Rockefeller role. |

The CRM supports `valid`, `invalid`, and `unknown` email validity. A past
organization role does not by itself prove an address is undeliverable, so only
Hassan's address is marked invalid based on the owner's explicit statement.

## Still held for human review

| Flodesk email | Possible CRM person | Reason held back |
|---|---|---|
| cooperbarbarajeannie68@gmail.com | Barbara Cooper | First name and surname appear, but “jeannie68” may indicate a shared or differently owned address. |
| mjdorer@gmail.com | Michael Dorer | First initial and surname match, but the unexplained “j” and non-unique historical-message associations leave uncertainty. |

No archived CRM person reached the two-signal review threshold.

## Safety and re-run behavior

The migration aborts unless:

- all 28 reviewed people are still active;
- all 28 current-subscriber contacts exist;
- none of the addresses belongs to an unexpected CRM record;
- migration 0233 has already completed.

It uses deterministic IDs and verifies all email, contact, engagement,
subscription, and audit state before commit. After a successful run, re-running
the exact command is a no-op that re-verifies the completed state.
