---
name: Flodesk subscriber sync
description: Durable design decisions for the CRM↔Flodesk people sync (replaced Mailchimp).
---

# Flodesk subscriber sync

People-only sync into ONE Flodesk segment. Replaced the cancelled Mailchimp plan.

## Auth scheme (deviation worth remembering)

Flodesk's public API uses **HTTP Basic** auth (API key as username, empty
password), NOT the `Authorization: Bearer` the task brief assumed. Default is
Basic; `FLODESK_AUTH_SCHEME=bearer` overrides. Flodesk also **requires a
`User-Agent` header** or it rejects requests.
**Why:** verified live — the reconcile only succeeded with Basic.
**How to apply:** if Flodesk calls start 401-ing, check the scheme env before
touching the key.

## Config gating

Requires both `FLODESK_API_KEY` (secret) and `FLODESK_SEGMENT_ID` (env). The
outbound helper is a deliberate **no-op when not configured** so person
create/update never breaks; the scheduler + manual script fail loudly instead.
Base URL override: `FLODESK_API_BASE`.

## Precedence — the two directions must not fight

- Inbound reconcile is **monotonic**: only ever SETS `unsubscribedToNewsletter
  = true`, never clears it.
- Outbound guards the reverse: before (re)subscribing an eligible person it
  calls `getSubscriber` and, if Flodesk already shows `unsubscribed`, mirrors
  that into the CRM instead of resurrecting them.

**Why:** without this a stale CRM subscribe would un-unsubscribe someone who
opted out in Flodesk (and vice versa). Most-recent explicit status wins.

## Locking / scheduling

Inbound subscriber and campaign-evidence reconcile runs daily off-hours
(America/Chicago) under a **global pg advisory lock** keyed `(9001, 2)` — note
media ingest uses `(9001, 1)`; keep new off-hours jobs on distinct second-ints.
Manual trigger `sync:flodesk` forces a run but goes through the same lock +
`flodesk_sync_state` singleton, so it can't collide with the scheduled run.

The official Flodesk MCP is now the ongoing campaign/open/click source. It must
expose `rank_emails` and `list_email_recipients`. Configure
`FLODESK_MCP_URL` and, only when the URL does not carry authorization, a scoped
`FLODESK_MCP_AUTH_TOKEN`. The job discovers campaigns daily, refreshes each one
daily through day 14, then weekly. `newsletter_campaigns.provider_campaign_id`
is the provider identity and `last_engagement_synced_at` is the per-campaign
watermark. Historical workbook rows are adopted only on exact normalized subject
plus UTC send date. Recipients link only by exact normalized CRM email; unmatched
evidence remains unmatched and no people are created.

Until Flodesk exposes that server URL, the production bridge is a daily ChatGPT
Work task using the official Flodesk app plus WFCRM's narrow remote MCP endpoint.
`FLODESK_CHATGPT_MCP_AUTH_TOKEN` authenticates the WFCRM app. The planning tool
keeps cadence authority in the CRM; recipient pages merge through the same
monotonic functions, and only a final page advances the campaign watermark.
Retire the ChatGPT task when the direct MCP path is verified; do not intentionally
run both paths as parallel authorities.

## Historical/backfill boundary

The reviewed Flodesk workbook import through `/newsletter` remains available for
historical recovery. It is idempotent, preserves unmatched addresses without
creating CRM people, and leaves the workbook itself out of git. MCP evidence is
monotonic when merged with it: booleans OR, counts and timestamps take the
greatest value, and clicked links are unioned. Flodesk cannot remove bot clicks
from its analytics, so clicks are directional evidence, not proof of a human
action.

`syncPersonToFlodesk` remains bulk-safe (never throws; returns a result), so an
outbound audience backfill is still a thin loop over eligible people.
