---
status: runbook
last_verified: 2026-07-22
---

# Data sources: provenance, sync ownership, and resync procedures

This document owns data provenance and operational sync procedures. The
per-table schema map is [`../../lib/db/SCHEMA.md`](../../lib/db/SCHEMA.md).

## Provenance summary

| Source | Kind | Sync status |
|---|---|---|
| Copper (via manually cleaned Airtable "CRM Files") | Historical CRM records | **One-time import, CLOSED — never resync** |
| Schools Airtable base | School directory | Ongoing one-way mirror (Airtable → CRM) |
| QuickBooks Online | Accounting evidence | Ongoing pull-only sync |
| Stripe | Payment-processor evidence | Ongoing pull-only sync |
| Donorbox | Donor/purpose evidence | Ongoing pull-only sync |
| Gmail / Google Calendar | Communications | Ongoing per-user sync |
| Flodesk | Newsletter audience | Ongoing push of eligible people |
| GDELT | Media mentions | Ongoing pull |

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
  writes to QuickBooks.
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
  cursors in `email_sync_state` / `calendar_sync_state`.
- **Flodesk** — newsletter-eligible people (driven by the `people.newsletter`
  flags) are pushed to Flodesk; state in `flodesk_sync_state`.
- **GDELT** — press coverage into `media_mentions`; cursor in
  `media_ingest_state`.
