---
status: current-status
last_verified: 2026-11-11
---

# Zoom integration

## What exists today

Only the event subscription endpoint: `POST /api/integrations/zoom/webhook`
(`artifacts/api-server/src/routes/zoomWebhook.ts`, contract operation
`receiveZoomWebhook`).

- It belongs to the **WFCRM** Zoom Server-to-Server OAuth app. WFTLS has its own
  Zoom app, endpoint and secrets; the two are independent.
- Authentication is Zoom's request signature, not a user session. The route is
  mounted with the other machine-to-machine routers, ahead of session auth.
- It answers Zoom's `endpoint.url_validation` challenge, verifies
  `x-zm-signature` on every other event (HMAC-SHA256 over
  `v0:{timestamp}:{raw body}`, five-minute window), and acknowledges with 200.
- The raw request body is kept for this one path (see the JSON parser in
  `app.ts`) because Zoom signs the exact bytes it sent.
- **Nothing is stored and nothing is acted on.** The event name is logged;
  payloads are never logged because they carry participant names and emails.

## Secrets

| Secret (Replit) | Used for | Read today |
|---|---|---|
| `ZOOM_FORWFCRM_EVENTSUB_SECRET` | the event subscription Secret Token | yes |
| `ZOOM_FORWFCRM_ACCOUNT_ID`, `ZOOM_FORWFCRM_CLIENT_ID`, `ZOOM_FORWFCRM_CLIENT_SECRET` | calling Zoom's API | no — nothing calls Zoom yet |

Without the Secret Token the endpoint answers 503.

## Not built yet

Bringing recordings or transcripts into meeting notes. That work attaches at
`onZoomEvent` in the route file and needs decisions first: how a Zoom meeting is
matched to a person or funder, who may see a transcript, and whether recordings
are kept or only transcripts.
