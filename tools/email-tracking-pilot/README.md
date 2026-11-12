# Group reply tracking pilot

This prototype exercises the delivery step for per-recipient open tracking in
an existing Gmail thread. It takes the original RFC 5322 reply and the SMTP
envelope recipients. Each prepared delivery goes to one envelope recipient,
with the original From, To, Cc, Subject, Message-ID, In-Reply-To, and References
headers. The HTML part gets one new recipient-specific tracking image. Previous
images from the configured tracking origin are removed from quoted content.
Plain text, inline images, and attachments stay in the message.

## Local verification

From the repository root, with Python 3.11 or later:

```sh
python -B -m unittest discover -s tools/email-tracking-pilot -v
```

The test uses loopback SMTP and HTTP servers and synthetic addresses. It verifies
two To and two Cc recipients, one SMTP envelope recipient per copy, unchanged
thread headers, preserved MIME parts, and three image loads attributed to the
correct two recipients. It also verifies envelope subsets and Cc-only replies.

To inspect the prepared `.eml` files and their envelope mapping manually, use a
synthetic reply or a reply captured from a dedicated test mailbox:

```sh
python tools/email-tracking-pilot/prepare_delivery.py reply.eml pilot-output \
  --origin https://tracking.example.test \
  --recipient alex@example.test --recipient bea@example.test \
  --recipient chris@example.test --recipient dee@example.test
```

The command writes files locally. The generated IDs are pilot IDs and have no
corresponding WFCRM database rows. Keep real message files and output outside
the repository. This prototype covers HTML replies to direct To/Cc addresses.

## Live test plan

1. Use a dedicated Workspace test sender and controlled Gmail and Outlook
   recipient inboxes. Create a thread with at least two To and two Cc addresses.
2. Configure a Workspace routing rule for that sender and an explicit pilot
   message header. Route only marked pilot replies to the test gateway. Verify
   that Gmail stores a single Sent reply and passes the original SMTP envelope.
3. Have the gateway use one envelope recipient per personalized copy. The
   relay must authenticate mail for the sender's domain after modifying the HTML.
   Verify SPF/DKIM alignment and confirm one copy in each inbox with the full
   original To/Cc and the correct parent reply headers.
4. Open copies in a controlled order, check observed image loads by recipient
   and by reply, then Reply All from both clients. Confirm replies reach the
   expected participants and appear in the existing conversation. Reopening
   Sent and opening a new reply containing quoted text should leave earlier
   counts unchanged.
5. Exercise a temporary delivery failure. The gateway must keep a durable record
   of accepted deliveries and avoid resubmitting already accepted copies on retry.

For a WFCRM integration, register recipient IDs before delivery using the
existing `tracked_emails` group model. Associate the group with the exact Gmail
Sent message and thread. The gateway needs an authenticated registration path and
durable delivery state before it can handle live CRM mail. The local pilot does
not modify Gmail settings or use the current server-side split-send endpoint.

- [Google Workspace outbound gateway](https://knowledge.workspace.google.com/admin/gmail/advanced/add-an-outbound-gateway-for-outgoing-email)
- [Google Workspace header-based routing](https://knowledge.workspace.google.com/admin/gmail/advanced/set-up-rules-for-advanced-email-content-filtering)
- [Gmail thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads)
