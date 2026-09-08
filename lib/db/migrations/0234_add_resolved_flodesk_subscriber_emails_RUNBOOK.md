# Runbook — resolved Flodesk subscriber emails

## Purpose

Migration 0234 adds 22 conservatively resolved Flodesk current-subscriber
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
NOTICE:  0234: verified 22 resolved emails, contacts, engagement links, and subscribed people
```

## Reviewed automatic matches

| Flodesk email | CRM person |
|---|---|
| abeckner@imaginablefutures.com | Ashley Beckner |
| amy.gips@wildflowerschools.org | Amy Gips |
| aplancher@socialfinance.org | Annie Knickman Plancher |
| ccodellalow@bipartisanpolicy.org | Caitlin Codella Low |
| daniela.vasan@wildflowerschools.org | Daniela Vasan |
| erica.cantoni@wildflowerschools.org | Erica Cantoni |
| gregklein411@gmail.com | Greg Klein |
| jmccormick@fmcg.com | Jim McCormick |
| jparadis@chappellculper.org | Jennifer Paradis |
| kgarg@schmidtfutures.com | Kumar Garg |
| maia.blankenship@wildflowerschools.org | Maia Blankenship |
| mbazan@arnoldfoundation.org | Marissa Bazan |
| mchun@hewlett.org | Marc Chun |
| mdukes@overdeck.org | Melanie Dukes |
| paul.keys@teachforamerica.org | Paul Keys |
| rachel.kelley-cohn@wildflowerschools.org | Rachel Kelley-Cohn |
| rjohnson@citybridge.org | Rena Johnson |
| sunny.greenberg@wildflowerschools.org | Sunny Greenberg |
| ted.quinn@covariantgroup.com | Ted Quinn |
| tiffany.needham@teachforamerica.org | Tiffany Cuellar Needham |
| maas@closegapsby5.org | Ericca Maas |
| jim@freyfoundationmn.org | Jim Frey |

The first 20 match a unique CRM person's first name plus a distinctive
first+last, first-initial+last, or surname pattern in the email address. Ericca
Maas has unique first-name and surname evidence. Jim Frey's address is also
corroborated by four historical messages whose populated person associations
all point to Jim.

## Deliberately not linked

These plausible cases were retained for human review because the evidence does
not independently establish identity:

| Flodesk email | Possible CRM person | Reason held back |
|---|---|---|
| hassan@4pt0.org | Hassan Hassan | Both signals repeat the same single name. |
| scullyr@gmail.com | Bob Scully | The trailing “r” is unexplained and does not match Bob's initial. |
| brooke@chanzuckerberg.com | Brooke Stafford-Brizard | Name is first-name-only and message metadata includes another person. |
| shavar@dfer.org | Shavar Jeffries | Name is first-name-only and message metadata includes other people. |

No archived CRM person reached either the automatic-match or review threshold.

## Safety and re-run behavior

The migration aborts unless:

- all 22 reviewed people are still active;
- all 22 current-subscriber contacts exist;
- none of the addresses belongs to an unexpected CRM record;
- after 0233, the first-run state still has exactly four newsletter-status changes;
- migration 0233 has already completed.

It uses deterministic IDs and verifies all email, contact, engagement,
subscription, and audit state before commit. After a successful run, re-running
the exact command is a no-op that re-verifies the completed state.
