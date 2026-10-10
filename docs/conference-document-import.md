---
status: current-status
last_verified: 2026-10-10
---

# Conference directory import and review

The Conferences event workspace imports CSV/XLSX directories into the existing
conference import batches/rows and conference attendance tables. Select the annual
event first, upload or paste a document, preview original cells, identify its
worksheet/header row, and map name, organization, title and optional email columns.
Combined title/organization lines stay intact in original cells; reviewers must
identify an organization explicitly rather than let software invent a split.

## Identity and review

The shared `conferenceImportDocument.ts` parser/classifier distinguishes reliable
matches, ambiguous identities, proposed people at existing organizations, other
unmatched rows, and row errors. A unique email must be consistent with the supplied
name. Without email, a unique exact full name plus a unique current organization
affiliation corroborates identity. Organization equivalence reuses the conservative
primary/historical-name matcher. A name alone never establishes foundation status.

Reviewers can choose existing people, prepare a full-name/organization/title
proposal, explicitly approve rows, or reject rows. A new organization requires
explicit reviewer foundation evidence. Foundation subtype and grant-making status
remain unassessed; the evidence is retained on the import row and organization.
Existing person/organization data is reused rather than overwritten. Potential
duplicate identities block new-person creation and require a person choice.
Archived matching identities must be reviewed/restored before a duplicate is made.

`conferenceImportReview.ts` owns approval. It serializes import identity creation,
locks the batch, and rechecks current records. Each row uses a savepoint. Successful
rows remain approved; errors remain pending and can be corrected/retried. Unchecked
rows remain pending. A batch is confirmed only after every row is approved/rejected.
Approvals include atomic audit history; import rows retain source row, original
cells/name/title/organization/email, candidate IDs, reason, confidence, disposition,
review error, foundation evidence and resolved person. Batches retain document
SHA-256, source filename and mapping. The same mapped source rows resume the same
batch even across equivalent CSV/XLSX uploads. Changed/reordered sources get a new
batch, while attendee uniqueness and approval-time identity rechecks prevent repeats.

## Registration versus physical attendance

`conference_attendance.registration_listed` means a person was listed in an imported
conference directory. It does **not** prove physical attendance or that the directory
is a complete roster. Newly imported records use physical-attendance status
`possible`. Existing status, role, source and evidence remain untouched; the import
only sets the registration flag. Every accepted source row remains durable evidence,
including when several rows point to one attendee. Conference and CRM entity merges
preserve registration evidence and reassign import identity references.

## Input and security limits

Routes explicitly require authenticated write-capable CRM users. Read-only users
cannot preview/stage/review. Inputs are UTF-8 CSV or XLSX only, up to 2 MiB, 5,000
data rows, 100 columns and 10,000 characters per cell. XLSX archive sizes are checked
before parsing (20 MiB expanded maximum); encrypted archives, VBA and external
workbook links are rejected. Formulas are not evaluated. Malformed documents fail
with an actionable message; row identity errors remain visible in review.

Migrations `0273_conference_document_import.sql` and
`0274_conference_import_combined_fields.sql` in `lib/db/migrations` are additive and
idempotent. Apply them only through the normal reviewed release process, before using
the new code. No production migration or import has been run for this change.

## Verification

Synthetic parser/classifier tests cover CSV/XLSX parity, combined lines, blank source
rows, invalid files/mappings, no-email matches, duplicate names, mixed organizations
and uncertain foundation status. HTTP/PostgreSQL tests cover auth, staging races,
proposals, explicit evidence, rejection, partial failure/retry, repeated/changed
uploads, duplicate rows, and richer attendance preservation. The browser fixture
exercises the real component with mocked HTTP. An optional integration-backed Edge/Chromium test also drives that component against the real local HTTP routes and PostgreSQL database, including contextual duplicate-name candidates and the selected-record link. Enable it with `CONFERENCE_IMPORT_BROWSER_TEST=1` (and optionally `PLAYWRIGHT_BROWSER_CHANNEL=msedge`) when running the API integration suite. It uses no production Clerk session or data. Run:

```sh
pnpm --filter @workspace/api-server exec vitest run src/__tests__/conference-import-document.test.ts src/__tests__/conference-document-import.integration.test.ts
pnpm --filter @workspace/wildflower-crm exec playwright test --config e2e/conference-import.config.ts
```

Exact GFE artifact validation remains blocked by the current Library transfer
helper's Windows metadata incompatibility. XLSX ID
`libfile_aa7d06fa5c5c8191b25f37b948d1dbaa` and CSV ID
`libfile_8749f8e40adc819189fe1d5bafeb6c44` were not readable locally. The 755 source
entries, exact displayed headers and actual GFE layout have not been verified.
No workaround download or additional transfer retry was attempted.


## Combined displayed lines and identity review

Map a single displayed title/organization column with **Combined title / organization**. The original line and cells are always preserved. **Preview mapped splits** shows the proposed boundary before staging. A unique complete CRM organization name or historical alias at the end permits a corroborated split, including commas inside a title or organization. Multiple matches or boundaries require review. An unknown line may show a tentative role/employer split, but it remains ambiguous and never proves foundation eligibility. Verify/correct proposal fields explicitly before approval.

Candidate cards and the import-specific person picker show current organizations, emails when available, and stable record IDs. Each candidate has an inspection link; choosing an override updates the selected-person link immediately. Approval still rechecks the database. Person merges OR registration-listed evidence across duplicate attendee rows while retaining the richer physical attendance status, role, source and provenance.
