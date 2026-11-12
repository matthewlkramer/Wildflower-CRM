"""Deliver marked pilot replies from a Postfix queue and serve their pixels."""

import argparse
import base64
import json
import re
import smtplib
import sqlite3
import ssl
import sys
from contextlib import closing
from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
from pathlib import Path
from wsgiref.simple_server import WSGIRequestHandler, make_server

from prepare_delivery import PIXEL_PATH, prepare_deliveries


MAX_MESSAGE_BYTES = 25 * 1024 * 1024
PIXEL = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


class RetryDelivery(Exception):
    """A known failure before the relay accepted this copy."""


class RejectDelivery(Exception):
    """A permanent failure or message outside the configured pilot."""


@dataclass(frozen=True)
class PilotConfig:
    sender: str
    recipients: list[str]
    reply_subject: str
    tracking_origin: str
    database: str
    relay_host: str
    relay_port: int = 587
    relay_user: str | None = None
    relay_password_file: str | None = None

    def __post_init__(self):
        if not self.sender or not self.recipients or not self.reply_subject:
            raise ValueError("Pilot sender, recipients, and reply subject are required")
        if bool(self.relay_user) != bool(self.relay_password_file):
            raise ValueError("Provide both relay user and relay password file for SMTP authentication")


def connect(database):
    return sqlite3.connect(database, timeout=10)


def initialize(database):
    with closing(connect(database)) as db, db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS deliveries (
                message_id TEXT NOT NULL,
                recipient TEXT NOT NULL,
                pixel_id TEXT NOT NULL UNIQUE,
                message BLOB,
                state TEXT NOT NULL,
                observed_opens INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (message_id, recipient)
            )
        """)


def claim(database, message_id, delivery):
    with closing(connect(database)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("""
            INSERT INTO deliveries (message_id, recipient, pixel_id, message, state)
            VALUES (?, ?, ?, ?, 'pending') ON CONFLICT (message_id, recipient) DO NOTHING
        """, (message_id, delivery.recipient, delivery.pixel_id, delivery.message))
        state, message = db.execute("""
            SELECT state, message FROM deliveries WHERE message_id = ? AND recipient = ?
        """, (message_id, delivery.recipient)).fetchone()
        if state == "accepted":
            return None
        if state == "rejected":
            raise RejectDelivery("Relay rejected this copy")
        if state == "sending":
            raise RetryDelivery("Previous submission needs reconciliation before resending")
        db.execute("""
            UPDATE deliveries SET state = 'sending' WHERE message_id = ? AND recipient = ?
        """, (message_id, delivery.recipient))
        return message


def finish(database, message_id, recipient, state):
    with closing(connect(database)) as db, db:
        db.execute("""
            UPDATE deliveries SET state = ?, message = CASE WHEN ? = 'pending' THEN message END
            WHERE message_id = ? AND recipient = ?
        """, (state, state, message_id, recipient))


def forward_copy(config, recipient, message):
    smtp = None
    try:
        try:
            smtp = smtplib.SMTP(config.relay_host, config.relay_port, timeout=15)
            smtp.starttls(context=ssl.create_default_context())
            if config.relay_user:
                password = Path(config.relay_password_file).read_text(encoding="utf-8").rstrip("\r\n")
                smtp.login(config.relay_user, password)
        except (OSError, smtplib.SMTPException) as error:
            raise RetryDelivery("Could not establish the authenticated relay connection") from error

        try:
            smtp.sendmail(config.sender, [recipient], message)
        except smtplib.SMTPRecipientsRefused as error:
            code, _ = error.recipients[recipient]
            error_type = RejectDelivery if 500 <= code < 600 else RetryDelivery
            raise error_type(f"Relay refused the recipient with SMTP {code}") from error
        except (smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as error:
            error_type = RejectDelivery if 500 <= error.smtp_code < 600 else RetryDelivery
            raise error_type(f"Relay refused the submission with SMTP {error.smtp_code}") from error
    finally:
        if smtp is not None:
            smtp.close()


def deliver(config, sender, recipient, raw, submit=forward_copy):
    sender = sender.casefold()
    recipient = recipient.casefold()
    if sender != config.sender.casefold() or recipient not in {r.casefold() for r in config.recipients}:
        raise RejectDelivery("Envelope is outside the pilot")
    if len(raw) > MAX_MESSAGE_BYTES:
        raise RejectDelivery("Pilot message exceeds the size limit")

    headers = BytesParser(policy=policy.default).parsebytes(raw, headersonly=True)
    from_addresses = headers["From"].addresses if headers["From"] else ()
    if (len(from_addresses) != 1 or from_addresses[0].addr_spec.casefold() != sender
            or str(headers["Subject"]).casefold() != config.reply_subject.casefold()):
        raise RejectDelivery("From or reply subject is outside the pilot")

    try:
        delivery, = prepare_deliveries(raw, [recipient], config.tracking_origin)
    except ValueError as error:
        raise RejectDelivery(str(error)) from error
    message_id = str(headers["Message-ID"]).strip()
    initialize(config.database)
    message = claim(config.database, message_id, delivery)
    if message is None:
        return
    try:
        submit(config, recipient, message)
    except RetryDelivery:
        finish(config.database, message_id, recipient, "pending")
        raise
    except RejectDelivery:
        finish(config.database, message_id, recipient, "rejected")
        raise
    # A disconnect while sending, or failure to record acceptance, leaves the
    # row in 'sending'. Never automatically submit that copy a second time.
    finish(config.database, message_id, recipient, "accepted")


def pixel_app(database):
    initialize(database)

    def app(environ, start_response):
        path = environ["PATH_INFO"]
        if environ["REQUEST_METHOD"] == "GET" and PIXEL_PATH.fullmatch(path):
            with closing(connect(database)) as db, db:
                db.execute("""
                    UPDATE deliveries SET observed_opens = observed_opens + 1
                    WHERE pixel_id = ? AND state IN ('sending', 'accepted')
                """, (path.rsplit("/", 1)[1].removesuffix(".gif"),))
        start_response("200 OK", [("Content-Type", "image/gif"), ("Cache-Control", "no-store")])
        return [PIXEL]

    return app


class QuietPixelRequests(WSGIRequestHandler):
    def log_request(self, code="-", size="-"):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    submit = commands.add_parser("deliver")
    submit.add_argument("--sender", required=True)
    submit.add_argument("--recipient", required=True)
    serve = commands.add_parser("serve-pixels")
    serve.add_argument("--port", type=int, default=8081)
    commands.add_parser("status")
    args = parser.parse_args()

    try:
        config = PilotConfig(**json.loads(args.config.read_text(encoding="utf-8")))
        if args.command == "deliver":
            deliver(config, args.sender, args.recipient, sys.stdin.buffer.read(MAX_MESSAGE_BYTES + 1))
        elif args.command == "serve-pixels":
            with make_server("127.0.0.1", args.port, pixel_app(config.database),
                             handler_class=QuietPixelRequests) as server:
                server.serve_forever()
        else:
            initialize(config.database)
            with closing(connect(config.database)) as db:
                rows = db.execute("""
                    SELECT message_id, recipient, state, observed_opens
                    FROM deliveries ORDER BY message_id, recipient
                """).fetchall()
            keys = ("message_id", "recipient", "state", "observed_opens")
            print(json.dumps([dict(zip(keys, row)) for row in rows], indent=2))
    except RejectDelivery as error:
        print(f"5.7.1 {error}", file=sys.stderr)
        return 69
    except RetryDelivery as error:
        print(f"4.3.0 {error}", file=sys.stderr)
        return 75
    except (OSError, smtplib.SMTPException, sqlite3.Error, ValueError, TypeError) as error:
        # Configuration, message content, and relay responses may contain secrets.
        print(f"4.3.0 Pilot gateway could not complete delivery ({type(error).__name__})",
              file=sys.stderr)
        return 75
    return 0


if __name__ == "__main__":
    sys.exit(main())
