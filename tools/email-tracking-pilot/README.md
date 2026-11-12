# Group reply tracking pilot

This pilot exercises per-recipient open tracking in an existing Gmail thread.
It takes the original RFC 5322 reply and the SMTP
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
   subject equals the exact configured pilot reply subject, and any envelope
   recipient matches the anchored allowlist of participant addresses. Under
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

For a WFCRM integration, register recipient IDs before delivery using the
existing `tracked_emails` group model. Associate the group with the exact Gmail
Sent message and thread. The gateway needs an authenticated registration path and
durable delivery state before it can handle live CRM mail. The local pilot does
not modify Gmail settings or use the current server-side split-send endpoint.

- [Google Workspace outbound gateway](https://knowledge.workspace.google.com/admin/gmail/advanced/add-an-outbound-gateway-for-outgoing-email)
- [Google Workspace header-based routing](https://knowledge.workspace.google.com/admin/gmail/advanced/set-up-rules-for-advanced-email-content-filtering)
- [Gmail thread requirements](https://developers.google.com/workspace/gmail/api/guides/threads)
- [Postfix pipe transport](https://www.postfix.org/pipe.8.html)
