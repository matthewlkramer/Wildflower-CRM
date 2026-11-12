import tempfile
import unittest
from contextlib import closing
from email import policy
from email.parser import BytesParser
from pathlib import Path
from urllib.error import URLError

from crm_transport import CrmConfig, RejectDelivery, deliver_crm, export_crm
from gateway import connect, pixel_app
from test_prepare_delivery import ORIGIN, PIXEL_PREFIX, RECIPIENTS, group_reply


class CrmTransportTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        marker = root / "marker"
        marker.write_bytes(b"synthetic-test-marker\n")
        self.config = CrmConfig(
            senders=["sender@example.test"], tracking_origin=ORIGIN,
            database=str(root / "test.sqlite"), crm_endpoint="https://crm.example.test/api",
            crm_token_file=str(root / "test-token"), route_secret_file=str(marker),
        )
        self.message = group_reply().as_bytes(policy=policy.SMTP)
        self.routed = b"X-Wildflower-Mail-Gateway-Auth: synthetic-test-marker\r\n" + self.message
        self.delivered = []

    def submit(self, _config, recipient, raw, *, sender):
        self.delivered.append((sender, recipient, raw))

    def test_group_replies_export_distinct_dated_events_and_retry_pending_sync(self):
        for recipient in RECIPIENTS:
            deliver_crm(self.config, "sender@example.test", recipient, self.routed,
                        post=lambda *_: {"eligible": True}, submit=self.submit)
        self.assertEqual([row[1] for row in self.delivered], RECIPIENTS)
        original = BytesParser(policy=policy.default).parsebytes(self.message)
        with closing(connect(self.config.database)) as db:
            pixels = dict(db.execute("SELECT recipient, pixel_id FROM deliveries"))
        for _, recipient, raw in self.delivered:
            parsed = BytesParser(policy=policy.default).parsebytes(raw)
            for header in ("To", "Cc", "Subject", "In-Reply-To", "Message-ID", "References"):
                self.assertEqual(parsed[header], original[header])
            self.assertIsNone(parsed["X-Wildflower-Mail-Gateway-Auth"])
            self.assertIn(pixels[recipient], parsed.get_body(preferencelist=("html",)).get_content())

        app = pixel_app(self.config.database)
        for recipient in (RECIPIENTS[0], RECIPIENTS[0], RECIPIENTS[3]):
            app({"REQUEST_METHOD": "GET", "PATH_INFO": f"{PIXEL_PREFIX}{pixels[recipient]}.gif"},
                lambda *_: None)
        attempts = []

        def record(_, operation, payload):
            self.assertEqual(operation, "deliveries")
            attempts.append(payload)
            return {"status": "pending_sync" if len(attempts) == 1 else "imported"}

        export_crm(self.config, post=record)
        self.assertEqual(len(attempts), 4)
        self.assertEqual([len(row["events"]) for row in attempts], [2, 0, 0, 1])
        self.assertTrue(all(row["messageId"] == str(original["Message-ID"]) for row in attempts))
        self.assertTrue(all(event["observedAt"].endswith("Z") for row in attempts for event in row["events"]))
        with closing(connect(self.config.database)) as db, db:
            db.execute("UPDATE crm_export_state SET retry_after = 1 WHERE retry_after > 0")
        export_crm(self.config, post=record)
        export_crm(self.config, post=record)
        self.assertEqual(attempts[0], attempts[-1])
        self.assertEqual(len(attempts), 5)

    def test_crm_outage_delivers_original_and_excludes_it_from_export(self):
        def unavailable(*_):
            raise URLError("CRM unreachable")

        deliver_crm(self.config, "sender@example.test", RECIPIENTS[0], self.routed,
                    post=unavailable, submit=self.submit)
        self.assertEqual(self.delivered[0][2], self.message)
        export_crm(self.config, post=lambda *_: self.fail("Untracked mail must never be exported"))

    def test_untrusted_messages_cannot_use_the_relay(self):
        with self.assertRaises(RejectDelivery):
            deliver_crm(self.config, "sender@example.test", RECIPIENTS[0], self.message,
                        submit=self.submit)
        with self.assertRaises(RejectDelivery):
            deliver_crm(self.config, "unrelated@example.test", RECIPIENTS[0], self.routed,
                        submit=self.submit)
        self.assertEqual(self.delivered, [])


if __name__ == "__main__":
    unittest.main()
