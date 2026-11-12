import smtplib
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import patch

from gateway import (
    PilotConfig, RejectDelivery, RetryDelivery, connect, deliver, delivery_status,
    forward_copy, pixel_app,
)
from test_prepare_delivery import ORIGIN, PIXEL_PREFIX, RECIPIENTS, group_reply


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = PilotConfig(
            sender="sender@example.test", recipients=RECIPIENTS,
            reply_subject="Re: Grant conversation", tracking_origin=ORIGIN,
            database=str(Path(self.directory.name) / "pilot.sqlite"),
            relay_host="relay.example.test",
        )
        self.message = group_reply().as_bytes()
        self.submissions = []

    def submit(self, config, recipient, message):
        self.submissions.append((recipient, message))

    def rows(self):
        with closing(connect(self.config.database)) as db:
            return db.execute("""
                SELECT recipient, pixel_id, state, observed_opens, message
                FROM deliveries ORDER BY recipient
            """).fetchall()

    def test_gateway_delivers_to_four_addresses_and_counts_requests(self):
        for recipient in RECIPIENTS:
            for _ in range(2):
                deliver(self.config, self.config.sender, recipient, self.message, self.submit)
        self.assertEqual([recipient for recipient, _ in self.submissions], RECIPIENTS)

        rows = self.rows()
        self.assertEqual(len({row[1] for row in rows}), 4)
        self.assertTrue(all(row[2:] == ("accepted", 0, None) for row in rows))
        app = pixel_app(self.config.database)
        for index in (0, 0, 3):
            recipient, pixel_id, _, _, _ = rows[index]
            delivery = dict(self.submissions)[recipient]
            parsed = BytesParser(policy=policy.default).parsebytes(delivery)
            html = parsed.get_body(preferencelist=("html",)).get_content()
            self.assertIn(f"{ORIGIN}{PIXEL_PREFIX}{pixel_id}.gif", html)
            responses = []
            body = app({"REQUEST_METHOD": "GET", "PATH_INFO": f"{PIXEL_PREFIX}{pixel_id}.gif"},
                       lambda status, headers: responses.append((status, dict(headers))))
            self.assertEqual(responses[0][0], "200 OK")
            self.assertEqual(responses[0][1]["Cache-Control"], "no-store")
            self.assertTrue(body[0].startswith(b"GIF"))
        statuses = delivery_status(self.config.database)
        self.assertEqual([entry["recipient"] for entry in statuses], [row[0] for row in rows])
        self.assertEqual([entry["observed_opens"] for entry in statuses], [2, 0, 0, 1])
        self.assertEqual([len(entry["open_events"]) for entry in statuses], [2, 0, 0, 1])
        self.assertTrue(all(entry["message_id"] == str(group_reply()["Message-ID"]) for entry in statuses))
        events = [event for entry in statuses for event in entry["open_events"]]
        self.assertEqual(len({event["id"] for event in events}), 3)
        for event in events:
            self.assertEqual(datetime.fromisoformat(event["observed_at"]).tzinfo, timezone.utc)

    def test_older_counts_remain_available_without_invented_open_dates(self):
        deliver(self.config, self.config.sender, RECIPIENTS[0], self.message, self.submit)
        with closing(connect(self.config.database)) as db, db:
            db.execute("DROP TABLE open_events")
            db.execute("UPDATE deliveries SET observed_opens = 2")
        pixel_id = self.rows()[0][1]
        app = pixel_app(self.config.database)
        app({"REQUEST_METHOD": "GET", "PATH_INFO": f"{PIXEL_PREFIX}{pixel_id}.gif"},
            lambda status, headers: None)
        status, = delivery_status(self.config.database)
        self.assertEqual(status["observed_opens"], 3)
        self.assertEqual(len(status["open_events"]), 1)

    def test_known_retry_reuses_pixel_and_ambiguous_retry_does_not_resend(self):
        def fail_once(config, recipient, message):
            self.submit(config, recipient, message)
            raise RetryDelivery("Relay temporarily unavailable")

        with self.assertRaises(RetryDelivery):
            deliver(self.config, self.config.sender, RECIPIENTS[0], self.message, fail_once)
        deliver(self.config, self.config.sender, RECIPIENTS[0], self.message, self.submit)
        self.assertEqual(self.submissions[0], self.submissions[1])

        def disconnect(config, recipient, message):
            self.submit(config, recipient, message)
            raise smtplib.SMTPServerDisconnected("connection lost during DATA")

        with self.assertRaises(smtplib.SMTPServerDisconnected):
            deliver(self.config, self.config.sender, RECIPIENTS[1], self.message, disconnect)
        with self.assertRaisesRegex(RetryDelivery, "needs reconciliation"):
            deliver(self.config, self.config.sender, RECIPIENTS[1], self.message, self.submit)
        self.assertEqual(len(self.submissions), 3)

    def test_rejects_outside_sender_recipient_and_subject(self):
        for sender, recipient, message in (
            ("unrelated@example.test", RECIPIENTS[0], self.message),
            (self.config.sender, "unrelated@example.test", self.message),
            (self.config.sender, RECIPIENTS[0], self.message.replace(b"Re: Grant", b"Re: Other")),
        ):
            with self.assertRaises(RejectDelivery):
                deliver(self.config, sender, recipient, message, self.submit)
        self.assertEqual(self.submissions, [])

    @patch("gateway.smtplib.SMTP")
    def test_relay_requires_tls_and_submits_only_one_envelope_recipient(self, smtp):
        relay = smtp.return_value
        forward_copy(self.config, RECIPIENTS[0], self.message)
        smtp.assert_called_once_with("relay.example.test", 587, timeout=15)
        relay.starttls.assert_called_once()
        relay.sendmail.assert_called_once_with(
            self.config.sender, [RECIPIENTS[0]],
            b"X-Wildflower-Mail-Pilot-Processed: v1\r\n" + self.message,
        )
        self.assertEqual([call[0] for call in relay.method_calls], ["starttls", "sendmail", "close"])

        relay.starttls.side_effect = smtplib.SMTPNotSupportedError("no TLS")
        with self.assertRaises(RetryDelivery):
            forward_copy(self.config, RECIPIENTS[0], self.message)
        self.assertEqual(relay.sendmail.call_count, 1)


if __name__ == "__main__":
    unittest.main()
