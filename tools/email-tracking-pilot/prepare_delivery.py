"""Prepare recipient-specific SMTP deliveries for an existing HTML reply."""

import argparse
import json
import re
from dataclasses import dataclass
from email import policy
from email.encoders import encode_base64
from email.headerregistry import Address
from email.parser import BytesParser
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from secrets import token_urlsafe
from urllib.parse import unquote, urlsplit


PIXEL_PATH = re.compile(r"/api/email-tracking/track/[A-Za-z0-9_-]+\.gif")
PROXY_HOST = re.compile(r"ci\d+\.googleusercontent\.com")


@dataclass(frozen=True)
class Delivery:
    recipient: str
    pixel_id: str
    message: bytes


def is_tracking_image(src: str, origin: str) -> bool:
    try:
        url = urlsplit(src)
        if url.hostname and PROXY_HOST.fullmatch(url.hostname):
            url = urlsplit(unquote(url.fragment))
        return (
            f"{url.scheme}://{url.netloc}" == origin
            and PIXEL_PATH.fullmatch(url.path) is not None
        )
    except ValueError:
        return False


class TrackingImages(HTMLParser):
    def __init__(self, html: str, origins: tuple[str, ...]):
        super().__init__(convert_charrefs=False)
        self.origins = origins
        self.line_offsets = [0, *(match.end() for match in re.finditer("\n", html))]
        self.ranges = []
        self.body_end = len(html)
        self.feed(html)
        self.close()

    def source_offset(self):
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if tag == "img" and any(
            name == "src" and value and any(is_tracking_image(value, origin) for origin in self.origins)
            for name, value in attrs
        ):
            start = self.source_offset()
            self.ranges.append((start, start + len(self.get_starttag_text())))

    def handle_endtag(self, tag):
        if tag == "body":
            self.body_end = self.source_offset()

    def replace(self, html: str, image: str) -> str:
        result = []
        start = 0
        for left, right in sorted([*self.ranges, (self.body_end, self.body_end)]):
            result.append(html[start:left])
            if left == right:
                result.append(image)
            start = right
        result.append(html[start:])
        return "".join(result)


def prepare_deliveries(raw_message: bytes, envelope_recipients: list[str],
                       tracking_origin: str, *, require_reply: bool = True,
                       remove_origins: tuple[str, ...] = ()) -> list[Delivery]:
    origin = tracking_origin.rstrip("/")
    parsed_origin = urlsplit(origin)
    if (parsed_origin.scheme != "https" or not parsed_origin.hostname
            or parsed_origin.username is not None or parsed_origin.path
            or parsed_origin.query or parsed_origin.fragment):
        raise ValueError("Provide an HTTPS tracking origin without a path")

    message = BytesParser(policy=policy.SMTP).parsebytes(raw_message)
    required_headers = ("From", "Subject", "Message-ID")
    if require_reply:
        required_headers += ("In-Reply-To",)
    for name in required_headers:
        if len(message.get_all(name, [])) != 1 or not str(message[name]).strip():
            raise ValueError(f"Expected one {name} header on the original reply")
    for name in ("To", "Cc", "References", "In-Reply-To"):
        if len(message.get_all(name, [])) > 1:
            raise ValueError(f"Expected at most one {name} header on the original reply")
    visible = {
        address.addr_spec.casefold()
        for name in ("To", "Cc")
        for header in message.get_all(name, [])
        for address in header.addresses
    }
    recipients = {}
    for recipient in envelope_recipients:
        address = Address(addr_spec=recipient).addr_spec
        key = address.casefold()
        if key not in visible:
            raise ValueError("Every pilot envelope recipient must appear in To or Cc")
        recipients.setdefault(key, address)
    if not recipients:
        raise ValueError("Provide at least one actual envelope recipient")

    signed_or_encrypted = {
        "multipart/signed", "multipart/encrypted", "application/pkcs7-mime",
        "application/x-pkcs7-mime", "application/pgp-encrypted",
    }
    if any(part.get_content_type() in signed_or_encrypted for part in message.walk()):
        raise ValueError("Cannot personalize a signed or encrypted message")
    body = message.get_body(preferencelist=("html",))
    if body is None:
        raise ValueError("The pilot requires an HTML reply")
    html = body.get_content()
    tracking_images = TrackingImages(html, (origin, *remove_origins))
    body.set_param("charset", "utf-8", replace=True)

    # The body will change. A configured outbound relay must authenticate the
    # modified message using the sending domain's signing setup.
    for name in ("Bcc", "Resent-Bcc", "DKIM-Signature", "ARC-Seal",
                 "ARC-Message-Signature", "ARC-Authentication-Results"):
        del message[name]

    deliveries = []
    for recipient in recipients.values():
        pixel_id = token_urlsafe(18)
        src = escape(f"{origin}/api/email-tracking/track/{pixel_id}.gif", quote=True)
        pixel = f'<img src="{src}" width="1" height="1" alt="">'
        updated = tracking_images.replace(html, pixel)
        # Replace just the transfer-encoded payload. Keep Content-ID and the
        # rest of the MIME tree so inline images and attachments survive.
        body.set_payload(updated.encode("utf-8"))
        del body["Content-Transfer-Encoding"]
        encode_base64(body)
        deliveries.append(Delivery(recipient, pixel_id, message.as_bytes()))
    return deliveries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reply", type=Path)
    parser.add_argument("output", type=Path, help="New directory for prepared deliveries")
    parser.add_argument("--origin", required=True, help="Tracking endpoint origin")
    parser.add_argument("--recipient", action="append", required=True,
                        help="Actual SMTP envelope recipient (repeat for each recipient)")
    args = parser.parse_args()
    deliveries = prepare_deliveries(args.reply.read_bytes(), args.recipient, args.origin)
    args.output.mkdir()
    manifest = []
    for index, delivery in enumerate(deliveries, start=1):
        filename = f"delivery-{index}.eml"
        (args.output / filename).write_bytes(delivery.message)
        manifest.append({"file": filename, "envelope_recipient": delivery.recipient,
                         "pixel_id": delivery.pixel_id})
    (args.output / "deliveries.json").write_text(json.dumps(manifest, indent=2) + "\n",
                                               encoding="utf-8")


if __name__ == "__main__":
    main()
