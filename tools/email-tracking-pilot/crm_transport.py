"""Track eligible CRM mail in the Workspace gateway and export dated opens."""

import argparse
import hmac
import json
import re
import smtplib
import sqlite3
import sys
import time
from contextlib import closing
from dataclasses import dataclass
from email import policy
from email.errors import MessageError
from email.parser import BytesParser
from hashlib import sha256
from pathlib import Path
from secrets import token_urlsafe
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from gateway import (
    MAX_MESSAGE_BYTES, RejectDelivery, RetryDelivery, claim, connect, finish,
    forward_copy, initialize,
)
from prepare_delivery import Delivery, prepare_deliveries


ROUTE_HEADER = b"x-wildflower-mail-gateway-auth"
MESSAGE_ID = re.compile(r"<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>")
EXPORT_RETRY_SECONDS = 60


@dataclass(frozen=True)
class CrmConfig:
    senders: list[str]
    tracking_origin: str
    database: str
    crm_endpoint: str
    crm_token_file: str
    route_secret_file: str
    relay_host: str = "smtp-relay.gmail.com"
    relay_port: int = 587
    relay_user: str | None = None
    relay_password_file: str | None = None

    def __post_init__(self):
        endpoint = urlsplit(self.crm_endpoint)
        if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username
                or endpoint.query or endpoint.fragment):
            raise ValueError("Provide an HTTPS CRM endpoint")
        if not self.senders or bool(self.relay_user) != bool(self.relay_password_file):
            raise ValueError("Configure sender allowlist and complete relay credentials")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def crm_post(config, operation, data):
    token = Path(config.crm_token_file).read_text(encoding="utf-8").strip()
    if not token:
        raise ValueError("The CRM token file is empty")
    request = Request(
        f"{config.crm_endpoint.rstrip('/')}/{operation}",
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with build_opener(NoRedirect()).open(request, timeout=5) as response:
        result = json.loads(response.read(16_384))
    if not isinstance(result, dict):
        raise ValueError("Unexpected CRM response")
    return result


def remove_route_header(raw, secret):
    boundary = re.search(rb"\r?\n\r?\n", raw)
    if not boundary or not secret:
        raise RejectDelivery("Missing gateway routing authorization")
    separator = boundary.group()
    headers, body = raw[:boundary.start()], raw[boundary.end():]
    newline = b"\r\n" if separator.startswith(b"\r\n") else b"\n"
    fields = re.split(rb"\r?\n(?![ \t])", headers)
    kept = []
    credentials = []
    for field in fields:
        name, _, value = field.partition(b":")
        if name.lower() == ROUTE_HEADER:
            credentials.append(value.strip())
        elif name.lower() not in {b"bcc", b"resent-bcc"}:
            kept.append(field)
    if len(credentials) != 1 or not hmac.compare_digest(credentials[0], secret):
        raise RejectDelivery("Invalid gateway routing authorization")
    clean = newline.join(kept) + separator + body
    return clean.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def tracked_copy(config, sender, recipient, raw, headers, message_id, post):
    try:
        sender_header = headers["From"].addresses if headers["From"] else ()
        visible = sorted({
            address.addr_spec.casefold()
            for name in ("To", "Cc") for field in headers.get_all(name, [])
            for address in field.addresses
        })
        if (not MESSAGE_ID.fullmatch(message_id) or len(message_id) > 512
                or len(sender_header) != 1 or sender_header[0].addr_spec.casefold() != sender
                or recipient not in visible or len(visible) > 100):
            return None
        if post(config, "eligibility", {"sender": sender, "recipients": visible}).get("eligible") is True:
            crm = urlsplit(config.crm_endpoint)
            copy, = prepare_deliveries(raw, [recipient], config.tracking_origin, require_reply=False,
                                       remove_origins=(f"{crm.scheme}://{crm.netloc}",))
            return copy
    except (MessageError, OSError, ValueError):
        # The gateway must still deliver mail when CRM is temporarily unavailable
        # or a MIME format cannot safely take an image.
        print("CRM eligibility or personalization unavailable; delivering without tracking", file=sys.stderr)
    return None


def deliver_crm(config, sender, recipient, raw, *, post=crm_post, submit=forward_copy):
    sender, recipient = sender.casefold(), recipient.casefold()
    if sender not in {address.casefold() for address in config.senders} or len(raw) > MAX_MESSAGE_BYTES:
        raise RejectDelivery("Sender or message size is outside the CRM route")
    clean = remove_route_header(raw, Path(config.route_secret_file).read_bytes().strip())
    headers = BytesParser(policy=policy.default).parsebytes(clean, headersonly=True)
    message_id = str(headers["Message-ID"] or "").strip()
    ledger_id = f"{sender}\x1f{message_id or sha256(clean).hexdigest()}"
    copy = tracked_copy(config, sender, recipient, clean, headers, message_id, post)
    delivery = copy if copy else Delivery(recipient, token_urlsafe(18), clean)
    initialize(config.database)
    message = claim(config.database, ledger_id, delivery, sender=sender,
                    rfc_message_id=message_id if copy else None)
    if message is None:
        return
    try:
        submit(config, recipient, message, sender=sender)
    except RetryDelivery:
        finish(config.database, ledger_id, recipient, "pending")
        raise
    except RejectDelivery:
        finish(config.database, ledger_id, recipient, "rejected")
        raise
    finish(config.database, ledger_id, recipient, "accepted")


def export_crm(config, *, post=crm_post):
    initialize(config.database)
    with closing(connect(config.database)) as db, db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS crm_export_state (
                pixel_id TEXT PRIMARY KEY REFERENCES deliveries(pixel_id) ON DELETE CASCADE,
                event_cursor INTEGER NOT NULL,
                retry_after INTEGER NOT NULL,
                ignored INTEGER NOT NULL DEFAULT 0
            )
        """)
        pending = db.execute("""
            SELECT d.pixel_id, d.sender, d.recipient, d.rfc_message_id, COALESCE(s.event_cursor, 0)
            FROM deliveries d LEFT JOIN crm_export_state s ON s.pixel_id = d.pixel_id
            WHERE d.state = 'accepted' AND d.rfc_message_id IS NOT NULL
              AND COALESCE(s.ignored, 0) = 0 AND COALESCE(s.retry_after, 0) <= ?
              AND (s.pixel_id IS NULL OR s.retry_after > 0 OR EXISTS (
                SELECT 1 FROM open_events e WHERE e.pixel_id = d.pixel_id AND e.id > s.event_cursor
              ))
            ORDER BY COALESCE(s.retry_after, 0), d.rowid LIMIT 50
        """, (int(time.time()),)).fetchall()
    for pixel_id, sender, recipient, message_id, cursor in pending:
        with closing(connect(config.database)) as db:
            events = [dict(id=event_id, observedAt=observed_at) for event_id, observed_at in db.execute("""
                SELECT id, observed_at FROM open_events
                WHERE pixel_id = ? AND id > ? ORDER BY id LIMIT 100
            """, (pixel_id, cursor))]
        try:
            status = post(config, "deliveries", {
                "deliveryId": pixel_id, "sender": sender, "recipient": recipient,
                "messageId": message_id, "events": events,
            }).get("status")
        except (URLError, OSError, ValueError):
            status = None
            print("CRM open export will retry", file=sys.stderr)
        if status == "imported" and events:
            cursor = events[-1]["id"]
        retry_at = 0 if status in {"imported", "out_of_scope"} else int(time.time()) + EXPORT_RETRY_SECONDS
        with closing(connect(config.database)) as db, db:
            db.execute("""
                INSERT INTO crm_export_state (pixel_id, event_cursor, retry_after, ignored)
                VALUES (?, ?, ?, ?) ON CONFLICT (pixel_id) DO UPDATE SET
                  event_cursor = MAX(crm_export_state.event_cursor, excluded.event_cursor),
                  retry_after = excluded.retry_after, ignored = excluded.ignored
            """, (pixel_id, cursor, retry_at, status == "out_of_scope"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    submit = commands.add_parser("deliver")
    submit.add_argument("--sender", required=True)
    submit.add_argument("--recipient", required=True)
    commands.add_parser("export")
    args = parser.parse_args()
    try:
        config = CrmConfig(**json.loads(args.config.read_text(encoding="utf-8")))
        if args.command == "deliver":
            deliver_crm(config, args.sender, args.recipient, sys.stdin.buffer.read(MAX_MESSAGE_BYTES + 1))
        else:
            export_crm(config)
    except RejectDelivery as error:
        print(f"5.7.1 {error}", file=sys.stderr)
        return 69
    except (OSError, RetryDelivery, smtplib.SMTPException, sqlite3.Error, ValueError, TypeError) as error:
        print(f"4.3.0 CRM gateway could not complete the operation ({type(error).__name__})", file=sys.stderr)
        return 75
    return 0


if __name__ == "__main__":
    sys.exit(main())
