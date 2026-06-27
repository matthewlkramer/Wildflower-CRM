---
name: Grant-agreement Drive backfill
description: One-time pull of grant-agreement PDFs from Google Drive (coding_form_rows.drive_link) onto matched opportunities.
---

# Grant-agreement Drive backfill

Pulls grant-agreement PDFs from Google Drive links captured on
`coding_form_rows.drive_link` and attaches them onto the **matched
OPPORTUNITY/PLEDGE** via the existing grant-letter flow.

Invariants to protect:
- **Opportunities only, never gifts.** The PDF sets
  `grantLetterUrl/Filename/UploadedAt` on the opp; gifts have no grant letter.
- **Never silently overwrite.** A different existing grant letter is a `conflict`
  status / 409; it is only replaced when the reviewer sends `replace=true`.
- **Per-row, idempotent.** No background batch — each row is pulled on demand
  (the UI's "Import all ready" is a client-side sequential loop). Re-runs are
  noops on already-imported rows. A Drive fetch failure is a recorded per-row
  error returned as a 200 `failed` outcome, NOT a 5xx.
- **Status is derived** (`na`/`no_match`/`ready`/`imported`/`conflict`/`failed`)
  from the row + the matched opp's current letter; the import-tracking columns on
  `coding_form_rows` are the idempotency marker.

**Why:** the agent cannot write to prod and the coding-form rows with Drive links
are prod-only (0 in dev), so this feature is verified only as far as the Drive
client (connector token + a live Drive API call) — the real backfill is run by a
human against prod.

**Drive client:** `googleDrive.ts` uses the connector-token proxy pattern (mirror
of `airtableClient` — `connector_names=google-drive`, token never cached), then
direct `fetch` to `www.googleapis.com/drive/v3`. The `googleapis` npm package is
NOT needed. It validates a real PDF (`%PDF` magic + mime), rejects Google-native
docs/trashed/permission-denied with typed `DriveLinkError` reasons.
