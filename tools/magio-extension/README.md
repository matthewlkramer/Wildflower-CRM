# Wildflower Email Tracking Extension

Chrome/Brave extension that embeds an open-tracking pixel into outbound
Gmail messages and surfaces opens on the CRM. Vendored from the
upstream MIT-licensed [Magio](https://github.com/DeepakSilaych/Magio)
project by Deepak Silaych and repointed at the Wildflower CRM backend.

## What was changed from upstream

- All API URLs in `lib/api.ts` now point at `/api/email-tracking/*` on
  the CRM rather than upstream's `/api/emails`. This avoids collision
  with the CRM's existing synced-Gmail `/api/emails` router.
- `manifest.host_permissions` includes the Replit deployment domains
  (`*.replit.app`, `*.replit.dev`) plus `localhost` for dev builds.
- Popup rebranded to "Wildflower Tracking". Toggle behavior, compose-
  toolbar button, send-time pixel injection, sender-self-view filter,
  and Gmail sidebar are unchanged from upstream.

## Build & install (staff)

```bash
# 1) From the monorepo root
cd tools/magio-extension
pnpm install
PLASMO_PUBLIC_API_URL=https://<your-crm-domain> pnpm build
# Production bundle lands in build/chrome-mv3-prod/

# 2) In Chrome / Brave / Edge:
#    chrome://extensions  →  Developer mode ON  →  "Load unpacked"
#    Pick the build/chrome-mv3-prod/ folder.
# 3) Open mail.google.com. Compose a new email. You should see a small
#    eye icon next to the Send button — that's the tracking toggle.
```

## How it works (one-paragraph version)

When you click **Send** with tracking on, the content script POSTs the
subject + To: line + your address to `POST /api/email-tracking` on the
CRM, gets back an opaque id, and inserts a 1×1 invisible `<img>` into
the body whose src points at `GET /api/email-tracking/track/{id}.gif`.
The recipient's mail client loads the image when they open the email,
which logs the view (timestamp, IP, UA). The sender's own IP is
filtered for 5 minutes after send so your own peek doesn't count.

## Privacy

Recipients are **not** notified that the email is tracked. The CRM
operator (you) is responsible for any disclosure obligations under
local law. There is no programmatic disclosure in either the email
body or the tracking pixel.
