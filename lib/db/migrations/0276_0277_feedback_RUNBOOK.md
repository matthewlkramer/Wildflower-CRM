# October feedback release

Apply the additive schema migrations before publishing this code. Both are
idempotent; they preserve existing notes, interactions, and imported events.
From the repository root, a human runs:

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0276_activity_archive.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0277_calendar_bootstrap_window.sql
```

Migration 0275 records four feedback closeouts already applied under the user's
explicit queue-management authorization. It is guarded by open status and safe
to rerun, but is not a new prerequisite for the release.

Verify `notes.archived_at`, `interactions.archived_at`, and
`calendar_sync_state.bootstrap_time_max` exist, then Publish the merged code.
Do not publish the code before these columns exist. Rollback to the previous
code version preserves the additive columns, but its old DELETE endpoints
would again physically remove activity records; avoid using those actions.

After publication:

- Check mobile header search at 375px and desktop search; use a synthetic query.
- Hide/restore Moves, Application/close deadlines, and Projections; reload and
  verify the meeting owner filter also persists for the same account.
- On a designated test record, edit and delete a note and interaction. Verify
  active activity excludes them and their database rows remain archived.
- Record conference attendance; repeat selection must not create a duplicate
  or overwrite existing speaker/source evidence.
- Check Janine's Yass Prize gift in Giving & pipeline and regenerate her
  relationship summary. Principal/household attribution must retain the
  original donor and must not count a gift twice.
- Verify dictated notes remove filler/repetition while preserving distinct
  facts. Generate tasks from explicit staff notes. Background discussion alone
  must return no tasks; inspect long titles in the mobile proposal dialog.
- Recheck Allison's meeting in the trip timezone, Mike's unrelated historical
  email, and Jessica's bounce. Private bounce-ledger evidence is visible only
  to the traveler; a later successful reply supersedes the bounce.
- Run Calendar sync through Admin. Legacy unbounded cursors restart once;
  `bootstrap_time_max` remains fixed across resumed pages, completion is set
  only after the final error-free page, and no previously imported event or
  manual privacy choice is removed. New trip-window sweeps remain unchanged.
- Run the normal QuickBooks sync. Previously failed attachment rows are retried
  with fresh temporary download URLs. Inspect the Village Montessori deposit:
  composition changes only when distinct attachments sum exactly to the bank
  deposit total. Authentication/authorization errors remain visible and never
  justify inventing components or changing the donor of record.

Keep the twelve remaining feedback items open/in progress until their live
checks pass. A published commit or a passing mock-provider test alone is not a
live-provider verification. The cloud workspace's Anthropic credentials rejected
an actual synthetic request during development; verify the deployed integration
separately before closing the meeting-generation feedback.

## Feedback covered by this release

| Feedback ID | Behavior / closure check |
| --- | --- |
| `feedback_3kkR-09BWsfmLloMiLcq5` | Signed attachment download; verify Village Montessori composition after real QBO sync. |
| `feedback_bCr-rotMNt-Tqga2NyzWf` | Trip-local times, bounded outreach, recipient-specific bounces and later replies. |
| `feedback_f-ppddjNpZhRUQ-S3nC4h` | Fixed bootstrap horizon and progress to an error-free final page. |
| `feedback_ClaaOcfkSTo-8yELrI5fx` | Existing faithful dictation cleanup plus shared-provider task generation and recoverable failures. |
| `feedback_BuTXFwgYN8ALNLhQqdF9z` | Source-grounded conservative tasks, wrapped editable titles/context, expanded dialog, silent prerequisite save. |
| `feedback_4NJr3_PFXiJjq1L47TWX7` | Per-account browser meeting-owner preference. |
| `feedback_YNvMp8XYbLvba-vHGVQdx` | Note/interaction edits and logical deletion from activity. |
| `feedback_tLflB-wOx6N2SF09FqbPw` | Shared direct/household/principal giving scope for the pipeline and AI snapshot. |
| `feedback_bdPLhsB0H41h6TLse0aPG` | Compact contact add controls with one-line empty states. |
| `feedback_uoTvcAlfp5-VB7OabqWb0` | Record attendance on a person, preserving existing role/source evidence. |
| `feedback_Qt2XIg-4akaqg69dwDa3a` | Universal mobile header search with existing visibility/masking behavior. |
| `feedback_swZG1dl8mvMBRecPBidKB` | Hide/restore the bottom Moves, Deadlines, and Projections cards. |

The four previously closed items remain resolved. These twelve must not be
marked resolved until the relevant post-publication checks above pass.
