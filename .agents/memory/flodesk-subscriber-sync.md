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
Inbound reconcile runs daily off-hours (America/Chicago) under a **global pg
advisory lock** keyed `(9001, 2)` — note media ingest uses `(9001, 1)`; keep new
off-hours jobs on distinct second-ints. Manual trigger `sync:flodesk` forces a
run but goes through the same lock + `flodesk_sync_state` singleton, so it can't
collide with the scheduled run.

## Scope intentionally excluded
No campaign/open/click analytics — Flodesk's API exposes none. No bulk backfill
wired up, but `syncPersonToFlodesk` is bulk-safe (never throws; returns a result)
so a backfill is a thin loop over eligible people.
