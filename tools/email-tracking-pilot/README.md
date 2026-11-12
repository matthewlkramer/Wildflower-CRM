# Group reply tracking pilot

This pilot exercises per-recipient open tracking in an existing Gmail thread.
It takes the original RFC 5322 reply and the SMTP
envelope recipients. Each prepared delivery goes to one envelope recipient,
with the original From, To, Cc, Subject, Message-ID, In-Reply-To, and References
headers. The HTML part gets one new recipient-specific tracking image. Previous
images from the configured tracking origin are removed from quoted content.
Plain text, inline images, and attachments stay in the message.
Copies submitted to the outbound relay include
`X-Wildflower-Mail-Pilot-Processed: v1`, which the Workspace route excludes.

## Local verification

From the repository root, with Python 3.11 or later:

```sh
python -B -m unittest discover -s tools/email-tracking-pilot -v
```

The test uses loopback SMTP and HTTP servers and synthetic addresses. It verifies
two To and two Cc recipients, one SMTP envelope recipient per copy, unchanged
thread headers, preserved MIME parts, and three image loads attributed to the
correct two recipients. It also verifies envelope subsets, Cc-only replies,
relay TLS, and retry handling in the gateway's durable delivery ledger.

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
the repository. The pilot covers HTML replies to direct To/Cc addresses.

## Test gateway setup

Use a dedicated host with Postfix, a CA-signed SMTP certificate, an authorized
outbound SMTP relay that signs mail for the sender's domain, and an HTTPS name
for the image endpoint. Let Postfix handle the inbound SMTP connection and
durable queue. Keep this host separate from the CRM web deployment.

### Google Cloud deployment

`bootstrap-gcp.sh` provisions the test gateway on an Ubuntu 24.04 Compute
Engine VM. The startup script bundle starts with `#!/bin/bash` and defines
`GATEWAY_SOURCE` and `DELIVERY_SOURCE` as base64 strings containing `gateway.py`
and `prepare_delivery.py`. Append the contents of `bootstrap-gcp.sh` to that
header and pass the bundle as instance-level `startup-script` metadata. Set
`mail-pilot-domain` and `mail-pilot-reply-subject` instance metadata to the test
domain and exact reply subject. The script uses the `mail-pilot-sender` and
`mail-pilot-01` through `mail-pilot-04` accounts at that domain.

Use a static public IPv4 address. Allow HTTP and HTTPS for certificate
validation and tracking, SMTP from the current Google outbound mail ranges,
and SSH from Google IAP if needed for administration. The script installs a
Let's Encrypt IP certificate and a twice-daily renewal timer. Check that
`https://<ip>/api/email-tracking/track/healthcheck.gif` returns a GIF over a
trusted connection before configuring Workspace routing.

Add a separate Workspace SMTP relay entry for the VM's public IP. Restrict it
to registered Workspace senders and require TLS. The VM submits through
`smtp-relay.gmail.com:587` with STARTTLS. Exclude the processed header from the
Workspace rule to prevent the relay from returning the rewritten copies to
the VM.

### Manual setup

1. Configure the dedicated SMTP listener to require STARTTLS and accept mail
   only from Google Workspace delivery servers. Restrict the envelope sender
   and recipients to the test sender and participant addresses. Restrict this
   listener to the pilot transport and disable general relay and local delivery.
2. Run the transport under a dedicated unprivileged account with its own private
   writable state directory. Store the following settings in a readable config
   file outside the repository. Use a relay-specific service credential file if
   the authorized relay requires SMTP AUTH.

   ```json
   {
     "sender": "sender@example.test",
     "recipients": ["alex@example.test", "bea@example.test", "chris@example.test", "dee@example.test"],
     "reply_subject": "Re: WFCRM tracking pilot REPLACE_WITH_UNIQUE_TAG",
     "tracking_origin": "https://tracking.example.test",
     "database": "/var/lib/wfcrm-pilot/delivery.sqlite",
     "relay_host": "relay.example.test",
     "relay_port": 587
   }
   ```

   When SMTP AUTH is required, add `relay_user` and `relay_password_file` to
   the config. The relay connection always verifies the server's TLS certificate.
3. Set `wfcrm-pilot_destination_recipient_limit = 1` in `main.cf` and route
   only the allowlisted recipient addresses to the `wfcrm-pilot` pipe service.
   Example `master.cf` service for an installation in `/opt/wfcrm-pilot`:

   ```text
   wfcrm-pilot unix - n n - - pipe
     user=wfcrm-pilot argv=/usr/bin/python3 -B /opt/wfcrm-pilot/gateway.py
     --config /etc/wfcrm-pilot.json deliver --sender=${sender} --recipient=${recipient}
   ```

4. Run `gateway.py --config /etc/wfcrm-pilot.json serve-pixels` as the same
   service account. Use a TLS reverse proxy to expose only the
   `/api/email-tracking/track/` path from the loopback server on port 8081. Keep
   request logging off for that path to avoid logging pixel tokens. Check
   `gateway.py --config /etc/wfcrm-pilot.json status` locally for each reply and
   recipient. The ledger clears accepted/rejected payloads and retains the
   counts. Remove the pilot database and queued test data after verification.
5. Confirm Google Admin's **Test TLS connection** succeeds before enabling the
   route. If `status` shows `sending` after the transport process has exited,
   check the outbound relay logs for that Message-ID and envelope recipient.
   Reconcile with the relay's acceptance record before resetting or retrying
   the copy. The worker deliberately defers uncertain deliveries.

## Live test plan

1. Use an authorized Workspace sender and controlled test inboxes. Seed an
   ordinary thread with the unique pilot subject (without `Re:`), two To
   addresses, and two Cc addresses.
2. In Google Admin, add the test host under **Gmail → Hosts** with TLS,
   CA-signed certificate, and hostname verification enabled. Under **Gmail →
   Compliance → Content compliance**, add a rule named `WFCRM group reply
   pilot`. Select **Outbound** and **Internal-Sending**. Require all of these
   advanced content matches: envelope sender equals the configured sender,
   subject equals the exact configured pilot reply subject, an envelope
   recipient matches the anchored allowlist of participant addresses, and the
   full headers do not contain `X-Wildflower-Mail-Pilot-Processed: v1`. Under
   **Modify message**, select **Change route** and choose the test host. Verify
   that Gmail stores a single Sent reply and passes the original SMTP envelope.
3. Have the gateway use one envelope recipient per personalized copy. The
   relay must authenticate mail for the sender's domain after modifying the HTML.
   Verify SPF/DKIM alignment and confirm one copy in each inbox with the full
   original To/Cc and the correct parent reply headers.
4. Open copies in a controlled order, check observed image loads by recipient
   and by reply, then Reply All from both clients. Confirm replies reach the
   expected participants and appear in the existing conversation. Confirm the
   Gmail Sent copy has no image for that send. Open a subsequent gateway-delivered
   reply containing quoted text and check that it loads only the new image.
   A reply sent outside the gateway can carry a quoted image and load it again.
   Remove the scoped Workspace routing rule when done.
5. Exercise a temporary delivery failure. The gateway must keep a durable record
   of accepted deliveries and avoid resubmitting already accepted copies on retry.

### Live Workspace result, November 12, 2026

The sender used Gmail Reply All in a thread with two To and two Cc recipients.
Each of the four dedicated Workspace inboxes received one tracked copy in the
original conversation. The received message displayed both To and Cc lists,
showed TLS, and was signed by the Wildflower domain. A follow-up sent by a Cc
recipient reached the other four accounts in the same conversation.

Before opening the copies, all four counts were zero. Opening inbox 03's Cc
copy changed only its count to one. Reopening that copy in Gmail left the count
at one. Opening inbox 02's To copy changed only its count to one. Opening the
remaining copies brought all four counts to one. Gmail displayed the image
through its image proxy. Counts represent image fetches that reach the gateway.
The live test used internal Workspace inboxes and the gateway ledger.

The gateway now records each received image request as a separate UTC-dated
event for that message and recipient. The `status` command returns the events
and their combined count. Counts from the original pilot are preserved with no
event timestamps because the original gateway did not store them.

The original pilot uses dedicated accounts and the local ledger. Production
deliveries register with WFCRM through the separate authenticated export below.

## WFCRM transport and export

The dedicated production listener uses port 2525 and shares the pilot's
image service and ledger. The pilot stays on port 25. Install the CRM code
from the approved Git revision after configuring these two private files
under `/etc/wf-mail-pilot/`, readable only by root and `wfmailpilot`.

- The same bearer secret as Replit's `WFCRM_EMAIL_GATEWAY_TOKEN`.
- A separate Workspace routing secret for `X-Wildflower-Mail-Gateway-Auth`.

Set `WFCRM_EMAIL_GATEWAY_SENDERS` in Replit to the same comma-separated mailbox
allowlist. This also sends the existing Gmail extension through its native
send fallback for these mailboxes instead of its legacy multi-copy API.

Put `crm.json` in that directory with `senders` set to the exact enabled
Google mailbox addresses, `tracking_origin` set to the gateway HTTPS origin,
`database` set to `/var/lib/wf-mail-pilot/delivery.sqlite`, `crm_endpoint` set
to the CRM origin followed by `/api/integrations/email-gateway`, and
`crm_token_file` and `route_secret_file` set to the two private file paths.
Run `sudo bash install-crm-transport.sh <gateway-source-directory>`. The
installer adds a sender-restricted Postfix listener and a one-minute export
timer. Permit port 2525 only from Google's current outgoing mail ranges.

Use an isolated Workspace content-compliance rule requiring an exact match
against the enabled envelope-sender list and the absence of
`X-Wildflower-Mail-Pilot-Processed: v1`. Use the validated TLS mail host on
port 2525 and add `X-Wildflower-Mail-Gateway-Auth` with the private routing
value. The gateway removes it before delivery. Start with a narrow synthetic
subject match and verify external delivery and CRM attribution. When expanding
to ordinary outgoing mail, the same sender allowlist applies. Update both
the Workspace rule and gateway config when adding a mailbox.

The gateway checks eligibility against WFCRM's active Google grants and
existing CRM contact matching. It passes through mail when there is no match,
the CRM cannot answer, or the message cannot safely take a tracking image.
The export sends only accepted, tracked recipient metadata and observed events.
WFCRM checks the active grant, resolves the exact RFC Message-ID in Gmail Sent,
and attaches the events only after the existing Gmail sync has kept that email.
Event IDs make resubmission idempotent. No message bodies enter the export.

To stop production routing, disable the new Workspace rule and keep the
gateway and relay available while already queued messages finish delivery.

- [Google Workspace outbound gateway](https://knowledge.workspace.google.com/admin/gmail/advanced/add-an-outbound-gateway-for-outgoing-email)
- [Google Workspace header-based routing](https://knowledge.workspace.google.com/admin/gmail/advanced/set-up-rules-for-advanced-email-content-filtering)
- [Gmail thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads)
- [Postfix pipe transport](https://www.postfix.org/pipe.8.html)
