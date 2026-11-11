---
status: current-status
last_verified: 2026-11-11
---

# Zoom transcript integration

WFCRM requests Zoom Meeting Summary with transcript retention for qualifying
Wildflower-hosted calls. Zoom shows its AI notice. The integration never starts
audio or video recording and never downloads media. Phone participants can hear
Zoom's separate AI notification.

## Which meetings qualify

- A configured recurring development Zoom ID goes to the agenda for the
  occurrence's Chicago calendar week.
- A scheduled donor call needs one confirmed, shareable invitation on the
  host's synced Google Calendar, with the same Zoom ID and a start within
  20 minutes. WFCRM checks the current invitation through the existing Google
  connection when available, including Zoom links added as conference details.
  Declined guests do not qualify the call.
- An instant Zoom meeting or personal room can qualify when Zoom supplies the
  email of a recognized donor who joins. Zoom often withholds guest emails, so
  scheduled invitations are the dependable way to identify external donors.
  Calls hosted on another Zoom account are outside the integration.

The host must be an active, writable CRM user. Donor matching uses exact
addresses and current CRM relationships. A gift, opportunity, or grantmaking
organization establishes the fundraising relationship. Private and ambiguous
calendar matches are skipped.

## What appears in WFCRM

Zoom sends a transcript-ready event after the meeting. WFCRM downloads the
text for the exact meeting occurrence and uses the existing meeting summarizer.
It adds draft notes and follow-ups to the donor's meeting note or the weekly
agenda. Staff notes and existing task assignments are preserved. Staff confirm
follow-ups before creating tasks. A host or note in summary-only mode keeps the
new transcript text out of WFCRM. Other hosts see the imported text through
the usual meeting-note workspace.

Queue entries contain only routing metadata and use Zoom's occurrence UUID to
prevent duplicate imports when events are retried. A completion notification
or the meeting-end event can trigger import. The worker retries temporary
download and summarization failures for up to 48 hours. It never logs transcript
text, attendee emails, or Zoom tokens.

## Activation and verification

1. Use the existing **for WFCRM** Zoom Server-to-Server OAuth app and
   `POST /api/integrations/zoom/webhook`. Confirm Start Meeting, End Meeting,
   Participant/Host joined meeting and AIC transcript completed are subscribed.
   The webhook validates Zoom's challenge and checks the signature over the
   original bytes before queuing an event.
2. The app needs `meeting:update:in_meeting_controls:admin` and
   `cloud_recording:read:meeting_transcript:admin`. Enable Meeting Summary and
   the host's ability to retain, view, and manage meeting transcripts. Keep
   account-wide automatic transcription, automatic Meeting Summary, and
   automatic audio/video recording off for this workflow. Zoom documents that
   the live controls API requires cloud recording to be available as a control.
   That permission is distinct from starting a recording.
3. Apply `lib/db/migrations/0280_zoom_transcript_jobs.sql` before enabling capture.
   The existing Replit secrets are `ZOOM_FORWFCRM_EVENTSUB_SECRET`,
   `ZOOM_FORWFCRM_ACCOUNT_ID`, `ZOOM_FORWFCRM_CLIENT_ID` and
   `ZOOM_FORWFCRM_CLIENT_SECRET`. Set
   `ZOOM_FORWFCRM_DEVELOPMENT_MEETING_IDS` to the comma-separated dedicated
   recurring meeting numbers. Enable the worker with
   `ZOOM_FORWFCRM_TRANSCRIPTS_ENABLED=true`.
4. With staff as test participants, verify a matched donor invitation, one
   occurrence of the development meeting, and an unrelated meeting. Confirm
   the AI notice appears, no audio/video files are created, drafts land on the
   right note, and resending a completion event creates no duplicate. The
   existing transcript upload stays available if Zoom cannot supply a transcript.
