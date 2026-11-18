# November CRM feedback release

GitHub main and the published Replit app are separate. Check the release commit
in the Replit checkout, then apply the schema update before Publish.

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0283_development_agenda_and_trip_conferences.sql
```

The schema change is additive apart from replacing the finding uniqueness
index with one that excludes removed agenda items. It preserves active
records, existing agenda links, and all trip candidates. After publishing,
apply the two guarded record updates from the repository root.

```bash
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0284_restore_philly_yass_trip.sql
psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0285_scope_dialog_retreat_outreach.sql
```

## Verify the open reports

| Reports | Live check |
| --- | --- |
| `feedback_JW94BPIxE9xCc7JwtTVv4`, `feedback_57hbv7dLlaR9lJ7PRAkCR` | On a designated development agenda, use **Team Operations → Weekly development meetings**. Confirm links to past meetings still work, the four standing sections appear in order, and complete/remove actions are on the row. Open a following week's agenda first, add an unfinished item to the prior agenda, then reopen the next agenda. Check that its notes, links, and open tasks carry forward once. Remove an unrecorded carried item and reopen to confirm it stays off that agenda. |
| `feedback_L2Q59VF9AEb7P3Txtyi54`, `feedback_rIVzsTS4iMG_1sPbKHuT6` | Confirm Upcoming is the default, Past and Archived work for their respective records, Open shows details, and the restored Philly trip is in Past. |
| `feedback_Y4UZK3ot88lg8kZ4_auKx` | Check the Dialog Retreat trip links to the 2027 edition and Grantmakers for Education is the outreach scope. Event evidence and current affiliations can generate suggestions. Unworked local drafts are hidden by default and available through the local controls. Existing manual, annotated, contacted, and reviewed visits stay visible. **Hide completed trip** returns to Upcoming and keeps the trip in Past. |
| `feedback_-36PQrRZ-ihwFC5rsXI5s` | Archive a designated test meeting. Dashboard, Meetings, and shared CRM copies exclude it, and Undo restores it. Google Calendar remains the source event. |
| `feedback_9j-PCnWleK2Sn9qechHHz` | Measure cold first-data load on Individuals by name and with a computed sort, then Organizations and the main comparable lists. Record the route and database timing for any remaining bottleneck. |
| `feedback_3e4ercsPTC06gCMb9EApW`, `feedback_6_6anKmdi-4lnK6IF9O3I` | Check the tighter dashboard and annual series rows at desktop and phone widths. Keep dashboard cards independently customizable. Verify annual event counts against each edition's attendance records and opening a mini card shows that year. |

## October feedback verification

Migration 0281 and all three columns from 0276/0277 were present on the
production read replica on November 18. Matthew’s Calendar bootstrap completed
with no pending page and no current error. The November read-only checks
could not identify the Village Montessori deposit from its reported date and
total, or prove successful meeting task generation from the logs. Use the
[October release checklist](0276_0277_feedback_RUNBOOK.md) for the remaining
live checks. Resolve each report after its relevant live verification.
