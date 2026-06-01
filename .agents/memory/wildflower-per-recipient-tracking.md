---
name: Per-recipient email open tracking (Path A)
description: Durable constraints behind the Superhuman-style per-recipient Gmail open tracking in wildflower-crm + the magio extension.
---

# Per-recipient open tracking ("Path A")

Multi-recipient (2+ To+Cc) + no-attachment tracked sends are split SERVER-side into
one individualized Gmail-API copy per recipient (each shows full To/Cc, unique pixel).
Everything else (single recipient, replies, attachments/inline images, Bcc, any
failure) falls back to the legacy single-pixel + Gmail-send path.

**Why these guardrails exist (do not loosen without re-checking):**
- **Bcc must force fallback.** Each per-recipient copy renders the full To/Cc group;
  there's no way to represent a Bcc recipient without either leaking them into a
  visible header or silently dropping them. The extension bails if any Bcc chip exists.
- **Recipient extraction is region-scoped, never a global `span[email]` grab.**
  `regionEmails(composeWindow, 'To'|'Cc'|'Bcc')` reads chips only inside the labeled
  region. An unscoped grab would merge Bcc into To/Cc → privacy leak. If the labeled
  region can't be found (e.g. non-English Gmail UI), it returns [] → safe fallback.
- **Attachments/inline images force fallback.** The server re-emits the compose body
  HTML as a fresh MIME message; it can't carry Gmail's attachment blobs or cid:/blob:
  inline images. `hasAttachments` also returns true if the body has any `<img>`.
- **Replies/forwards stay on the legacy path** so threading with the original
  conversation is preserved (server-send would start a fresh thread among the copies).
  Detection is heuristic: subject prefix `Re:`/`Fwd:`/`Fw:`/`Aw:`/`Wg:` OR the compose
  lives inside `div[role="main"]` (inline reply).
- **On success the extension discards the Gmail draft** (the Gmail API already saved
  the copies to Sent) to avoid a duplicate send / lingering draft, and shows its own
  toast because Gmail's "Draft discarded" snackbar would otherwise read as "not sent".

**Duplicate-send safety is the load-bearing correctness rule.** The extension must
NEVER fall back to a legacy Gmail UI send once the server *might* have delivered a
copy, or recipients get the email twice. `sendTrackedEmail` returns a 3-way outcome:
- `sent` → discard the Gmail draft (copies already in Sent).
- `not_sent` → server reached but delivered nothing (400/401/409, or a 502 whose
  `details.sent` is empty = first copy failed) → safe to fall back to legacy send.
  The common "user hasn't reconnected Google for the new gmail.send scope" case is a
  409 here, so the email still goes out via the legacy path.
- `uncertain` → partial 502 (`details.sent` non-empty), unknown 5xx, or no response →
  a copy may already be out → HALT: warn the user to check Sent, do NOT auto-resend.
**Why:** the server sends copies sequentially with no idempotency key; a blind
fallback after a partial failure double-sends to already-delivered recipients.

**Auth path:** extension has no Clerk session. User generates a per-user token in CRM
Settings (stored `users.extension_token`, UNIQUE), pastes into the extension popup
(`chrome.storage.local`), and the extension sends it as `X-Extension-Token` to
`POST /api/email-tracking/send`. Server resolves token → user → that user's Google
tokens and sends from `users/me`. **New `gmail.send` scope** means every user must
reconnect Google once; until then `/send` 4xxes and the extension falls back cleanly.

**Extension is NOT in the pnpm workspace.** Typecheck it with its own
`node_modules/.bin/tsc --noEmit -p tsconfig.json` (plasmo base config). Rebuild with the
dev URL baked in via `PLASMO_PUBLIC_API_URL="https://$REPLIT_DEV_DOMAIN"` then
`plasmo build && plasmo package && cp build/chrome-mv3-prod.zip build/wildflower-tracking-extension.zip`.
