import re
import smtplib
import socketserver
import threading
import unittest
from collections import Counter
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import urlopen

from prepare_delivery import prepare_deliveries


ORIGIN = "https://tracking.example.test"
PIXEL_PREFIX = "/api/email-tracking/track/"
RECIPIENTS = ["alex@example.test", "bea@example.test", "chris@example.test", "dee@example.test"]


def group_reply():
    message = EmailMessage(policy=policy.SMTP)
    message["From"] = "Sender <sender@example.test>"
    message["To"] = f"Alex <{RECIPIENTS[0]}>, Bea <{RECIPIENTS[1]}>"
    message["Cc"] = f"Chris <{RECIPIENTS[2]}>, Dee <{RECIPIENTS[3]}>"
    message["Subject"] = "Re: Grant conversation"
    message["Message-ID"] = "<reply@example.test>"
    message["In-Reply-To"] = "<parent@example.test>"
    message["References"] = "<original@example.test> <parent@example.test>"
    message["DKIM-Signature"] = "signature-for-original-body"
    message.set_content("Thanks for the update.")
    message.add_alternative(f'''<html><body><p>Thanks for the résumé.</p>
<blockquote><img alt='old image' src='{ORIGIN}{PIXEL_PREFIX}old.gif'>
<IMG SRC="https://ci3.googleusercontent.com/proxy#https%3A%2F%2Ftracking.example.test%2Fapi%2Femail-tracking%2Ftrack%2Fold2.gif" />
<img src="https://different.example.test{PIXEL_PREFIX}preserved.gif">
</blockquote><img src="cid:logo@example.test"></body></html>''', subtype="html", charset="iso-8859-1")
    message.get_body(preferencelist=("html",)).add_related(
        b"inline image", maintype="image", subtype="png", cid="<logo@example.test>"
    )
    message.add_attachment(b"attachment contents", maintype="application", subtype="pdf",
                           filename="packet.pdf")
    return message


class MailSink(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 pilot.local\r\n")
        envelope = []
        for line in self.rfile:
            command, _, argument = line.decode("ascii").strip().partition(" ")
            command = command.upper()
            if command == "MAIL":
                envelope = []
            if command == "RCPT":
                envelope.append(argument.split(":", 1)[1].strip("<>"))
            if command == "DATA":
                self.wfile.write(b"354 Send message\r\n")
                data = []
                for data_line in self.rfile:
                    if data_line == b".\r\n":
                        break
                    data.append(data_line[1:] if data_line.startswith(b"..") else data_line)
                else:
                    return
                self.server.deliveries.append((tuple(envelope), b"".join(data)))
            if command == "QUIT":
                self.wfile.write(b"221 Bye\r\n")
                return
            self.wfile.write(b"250 OK\r\n")


class PixelSink(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in self.server.open_counts:
            self.send_error(404)
            return
        self.server.open_counts[self.path] += 1
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        pass


class GroupReplyPilotTest(unittest.TestCase):
    def run_server(self, server):
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def test_group_reply_keeps_thread_and_attributes_loads_by_recipient(self):
        original = group_reply()
        deliveries = prepare_deliveries(original.as_bytes(), RECIPIENTS, ORIGIN)
        mail_sink = socketserver.TCPServer(("127.0.0.1", 0), MailSink)
        mail_sink.deliveries = []
        with smtplib.SMTP("127.0.0.1", self.run_server(mail_sink), timeout=5) as smtp:
            for delivery in deliveries:
                smtp.sendmail("sender@example.test", [delivery.recipient], delivery.message)

        self.assertEqual([envelope for envelope, _ in mail_sink.deliveries],
                         [(recipient,) for recipient in RECIPIENTS])
        pixel_paths = {}
        for (recipient,), raw in mail_sink.deliveries:
            message = BytesParser(policy=policy.SMTP).parsebytes(raw)
            for name in ("From", "To", "Cc", "Subject", "Message-ID", "In-Reply-To", "References"):
                self.assertEqual(str(message[name]), str(original[name]))
            self.assertIsNone(message["DKIM-Signature"])
            self.assertEqual(message.get_body(preferencelist=("plain",)).get_content().strip(),
                             "Thanks for the update.")
            html = message.get_body(preferencelist=("html",)).get_content()
            self.assertIn("Thanks for the résumé.", html)
            self.assertIn("cid:logo@example.test", html)
            self.assertNotIn("googleusercontent.com", html)
            self.assertNotIn(f"{ORIGIN}{PIXEL_PREFIX}old.gif", html)
            self.assertIn(f"https://different.example.test{PIXEL_PREFIX}preserved.gif", html)
            self.assertEqual(next(message.iter_attachments()).get_payload(decode=True),
                             b"attachment contents")
            inline = next(part for part in message.walk() if part["Content-ID"])
            self.assertEqual(inline.get_payload(decode=True), b"inline image")
            urls = re.findall(re.escape(ORIGIN) + r'(/[^"\s]+\.gif)', html)
            self.assertEqual(len(urls), 1)
            pixel_paths[recipient] = urls[0]

        self.assertEqual(len(set(pixel_paths.values())), 4)
        pixel_sink = HTTPServer(("127.0.0.1", 0), PixelSink)
        pixel_sink.open_counts = Counter({path: 0 for path in pixel_paths.values()})
        port = self.run_server(pixel_sink)
        for recipient in (RECIPIENTS[0], RECIPIENTS[0], RECIPIENTS[3]):
            with urlopen(f"http://127.0.0.1:{port}{pixel_paths[recipient]}", timeout=5) as response:
                self.assertEqual(response.status, 204)
        self.assertEqual([pixel_sink.open_counts[path] for path in pixel_paths.values()], [2, 0, 0, 1])
        original_html = original.get_body(preferencelist=("html",)).get_content()
        for path in pixel_paths.values():
            self.assertNotIn(path, original_html)

    def test_delivers_only_to_actual_envelope_addresses(self):
        raw = group_reply().as_bytes()
        deliveries = prepare_deliveries(raw, [RECIPIENTS[2], RECIPIENTS[2].upper()], ORIGIN)
        self.assertEqual([delivery.recipient for delivery in deliveries], [RECIPIENTS[2]])
        with self.assertRaisesRegex(ValueError, "must appear in To or Cc"):
            prepare_deliveries(raw, ["unrelated@example.test"], ORIGIN)

    def test_accepts_cc_only_reply_without_references(self):
        original = group_reply()
        del original["To"]
        del original["References"]
        deliveries = prepare_deliveries(original.as_bytes(), RECIPIENTS[2:], ORIGIN)
        self.assertEqual(len(deliveries), 2)
        self.assertTrue(all(b"In-Reply-To: <parent@example.test>" in d.message for d in deliveries))


if __name__ == "__main__":
    unittest.main()
