---
name: Grant-agreement Drive backfill
description: One-time pull of grant-agreement documents (PDF/image/Word) from Google Drive (coding_form_rows.drive_link) onto matched opportunities.
---

# Grant-agreement Drive backfill

Pulls grant-agreement documents from Google Drive links captured on
`coding_form_rows.drive_link` and attaches them onto the **matched
OPPORTUNITY/PLEDGE** via the existing grant-letter flow.

Invariants to protect:
- **Accept the SAME document set as the manual grant-letter upload**
  (`application/pdf, image/*, .doc, .docx`) — NOT PDF-only. **Why:** real
  coding-form "grant agreements" are frequently phone photos / screenshots of a
  signed page, so a PDF-only importer would fail most rows. Only a PDF-claiming
  file is `%PDF`-magic-checked; images/Word are trusted by mime/extension (the
  manual upload does no sniffing either). Google-native Docs/Sheets/Slides are
  still rejected (`unsupported_type`) — they can't be `alt=media` downloaded.
  Preserve the file's REAL name + content-type (don't force `.pdf`).
- **Opportunities only, never gifts.** The document sets
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

**Verified end-to-end in dev (mechanism is correct):** seeded synthetic
`coding_form_rows` against real Drive files + dev object storage + dev opps and
confirmed all paths — ready→`imported` for a **real PDF, jpeg, png, AND docx**
(each lands on the opp with its REAL filename + content-type, never a gift),
re-run→`already_imported` no-op, existing-different-letter→`conflict` (kept;
`replace:true`→`imported{replaced:true}`), unreachable id→`failed: not_found`
recorded on the row (no 5xx). Dev state fully snapshotted + restored after.

**BLOCKER 1 (RESOLVED by user) — Drive file visibility.** The grant-agreement
links are Google-Form file-upload responses in the form owner's "(File
responses)" folder. Originally the connected account
(matthew.kramer@wildflowerschools.org) got **404 for all 264 file ids**; after the
user fixed sharing (same connected account) a read-only recheck showed **241/264
now reachable** (143 PDF, 53 jpeg, 43 png, 1 heic, 1 docx) with **23 still
http_404** + 4 unparseable placeholder links. Decision: proceed and let the 23
record as `not_found` to chase individually. Drive 404 (not 403) = no-access.

**BLOCKER 2 — prod data/schema not staged.** `coding_form_rows` does NOT exist in
prod (table never published; only the opp `grant_letter_*` cols are there) and dev
has 0 rows. dev's table was also missing the `grant_letter_imported_*` cols
(added additively). Source sheets in `attached_assets/` parse to 284 rows / 283
links / 264 unique file ids (+4 placeholder-text "links" → `unparseable`). Rows
also need the matcher + human match-confirm before any becomes `ready`. So before
the real run: Publish (lands the table in prod) → seed rows in prod
(`import:coding-forms`) → confirm matches → then in-app import.

**Drive client:** `googleDrive.ts` uses the connector-token proxy pattern (mirror
of `airtableClient` — `connector_names=google-drive`, token never cached), then
direct `fetch` to `www.googleapis.com/drive/v3`. The `googleapis` npm package is
NOT needed. `classifyDocument` accepts PDF/image/Word (see the accept-set
invariant above), PDF-magic-checks only PDFs, and rejects
Google-native/trashed/permission-denied/empty with typed `DriveLinkError` reasons
(`unsupported_type` replaced the old `not_pdf`).
