---
status: runbook
last_verified: 2026-09-08
---

# Data sources: provenance, sync ownership, and resync procedures

This document owns data provenance and operational sync procedures. The
per-table schema map is [`../../lib/db/SCHEMA.md`](../../lib/db/SCHEMA.md).

## Provenance summary

| Source                                             | Kind                       | Sync status                                |
| -------------------------------------------------- | -------------------------- | ------------------------------------------ |
| Copper (via manually cleaned Airtable "CRM Files") | Historical CRM records     | **One-time import, CLOSED — never resync** |
| Schools Airtable base                              | School directory           | Ongoing one-way mirror (Airtable → CRM)    |
| QuickBooks Online                                  | Accounting evidence        | Ongoing pull-only sync                     |
| Stripe                                             | Payment-processor evidence | Ongoing pull-only sync                     |
| Donorbox                                           | Donor/purpose evidence     | Ongoing pull-only sync                     |
| Gmail / Google Calendar                            | Communications             | Ongoing per-user sync                      |
| Flodesk                                            | Newsletter audience + campaign evidence | Ongoing audience sync; reviewed workbook imports |
| GDELT                                              | Media mentions             | Ongoing pull                               |

## Closed source: Copper / Airtable CRM Files

Most historical data came from exports from Copper that the user manually
cleaned up in Airtable ("CRM Files") before a one-time import into the CRM.
That import is **complete and closed**: never resynchronize with Copper or with
the cleaned-up Airtable CRM Files. Legacy cross-reference columns
(`copper_pledge_id`, `legacy_gift_id`, `created_at_from_airtable`, etc.) are
preserved for traceability only.

## Schools (Airtable → CRM mirror)

- Source: the dedicated Wildflower **Schools** Airtable base
  (`appJBT9a4f3b7hWQ2`), "Data for CRM in Replit" view.
- One-way mirror into the `schools` table, upserting by Airtable record id
  (the Schools-base record IDs are the PKs). The sync never deletes — schools
  that fall out of the source view are counted as `stale_in_db` in
  `school_sync_state` for manual reconciliation (allocation FKs to schools are
  ON DELETE RESTRICT).
- An in-process daily scheduler runs the sync automatically;
  `school_sync_state` (singleton row) records the last run's status and counts.
- Manual resync command (wipes and reloads from the source view):

```bash
AIRTABLE_TOKEN=... node lib/db/src/sync-schools-from-airtable.mjs
```

## Ongoing money-evidence syncs (pull-only)

- **QuickBooks** — per-realm OAuth connections (`quickbooks_connections`) pull
  incoming-money records into the `staged_payments` review queue. The CRM never
  writes to QuickBooks. Source-owned amount/date/payer and capture facts refresh
  on incremental pulls even after a row is reconciled; donor, classification,
  approval, and unit→gift review facts remain CRM-owned and are not overwritten.
- **Stripe** — payouts and per-charge gross records
  (`stripe_payouts` / `stripe_staged_charges`), watermarked in
  `stripe_sync_state`.
- **Donorbox** — donations into `donorbox_donations`, watermarked in
  `donorbox_sync_state`. Donorbox is donor/purpose evidence, not transaction
  evidence.

Reconciliation semantics for these sources are governed by the reconciliation
document set (see [`../README.md`](../README.md)).

## Communications and other syncs

- **Gmail / Calendar** — per-user Google OAuth (`google_oauth_tokens`);
  cursors in `email_sync_state` / `calendar_sync_state`. Calendar incremental
  sync retains CRM-matched meetings; when the user has active `trip_plans`, a
  date-bounded pass also captures every primary-calendar event overlapping
  those travel windows. Unmatched trip events default private and expire when
  no active trip or linked CRM note requires them.
- **Flodesk** — newsletter eligibility derives from `newsletter_preference_events`;
  the two people flags are read-only projections. Staff removal removes the
  configured segment membership; opt-out suppresses delivery. Resubscription
  sends a known affirmative opt-in timestamp for Flodesk to validate. Inbound
  unsubscribe observations append source evidence with an unknown event date
  when the provider supplies none. Sync state remains in `flodesk_sync_state`. Historical
  audience, campaign, open, and click evidence can also be imported from the
  canonical Flodesk workbook on `/newsletter`. Imports upsert
  `newsletter_contacts`, `newsletter_campaigns`, and `newsletter_engagement`
  by stable email/campaign keys, link exact CRM email matches, and never create
  people from unmatched addresses. Workbook imports never change operational
  CRM subscription flags, email addresses, or email validity. Their result
  reports exact-email subscription-status differences and conservative possible
  email differences where an unmatched Flodesk address has one unambiguous
  exact-name CRM person match for human review. The workbook contains contact
  data and must not be committed to the repository.
- **GDELT** — press coverage into `media_mentions`; cursor in
  `media_ingest_state`.

### Newsletter preference evidence backfill

`backfill-newsletter-preferences.ts` reads the Flodesk subscriber API and the
School dbase sources `SSJ Fillout Forms` (`tblvgyMdMcidh8k6u`) and `Fillout Get
Involved results` (`tbls7U2BOBRQrfQTy`), base `appJBT9a4f3b7hWQ2`. It reads only
fields needed to verify the answer, source identity, date, and disposition.
Normalized answers/email must agree with their preserved form evidence.
A preserved form Entry Date is usable; a record's Last updated timestamp is
not a consent date. Unknown dates remain null. Exact email identity must match
one active CRM person. Ambiguous, test, and conflicting sources are reported
for review. No people are created and source systems are never modified.

Preview is the default; stable source keys make repeated application safe.
This is an explicit backfill, not a new scheduled Fillout sync. See the
[cutover runbook](../../lib/db/migrations/0246_0247_field_simplification_RUNBOOK.md).
Historical Flodesk and Mailchimp consent/opt-out evidence remains an open
Cleanup Queue project until those source records are located and reviewed.
Workbook campaign/engagement imports remain a separate evidence model.
