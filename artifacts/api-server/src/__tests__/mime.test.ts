import { describe, it, expect } from "vitest";
import { buildRawMessage } from "../lib/mime";

/** Decode the base64url raw message back to a UTF-8 string for assertions. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf-8");
}

/** Split headers from body (separated by a blank line). */
function parts(raw: string): { headers: string; body: string } {
  const text = decodeRaw(raw);
  const idx = text.indexOf("\r\n\r\n");
  return { headers: text.slice(0, idx), body: text.slice(idx + 4) };
}

describe("buildRawMessage", () => {
  it("emits From/To/Cc/Subject and an HTML content type", () => {
    const raw = buildRawMessage({
      from: "me@wildflowerschools.org",
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      subject: "Hello there",
      html: "<p>Hi</p>",
    });
    const { headers } = parts(raw);
    expect(headers).toContain("From: me@wildflowerschools.org");
    expect(headers).toContain("To: a@example.com, b@example.com");
    expect(headers).toContain("Cc: c@example.com");
    expect(headers).toContain("Subject: Hello there");
    expect(headers).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(headers).toContain("Content-Transfer-Encoding: base64");
  });

  it("omits the Cc header when no cc addresses are given", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@example.com"],
      subject: "No cc",
      html: "<p>x</p>",
    });
    const { headers } = parts(raw);
    expect(headers).not.toContain("Cc:");
  });

  it("base64-encodes the HTML body and round-trips", () => {
    const html = "<p>Hello &amp; welcome — テスト</p>";
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@example.com"],
      subject: "Body test",
      html,
    });
    const { body } = parts(raw);
    const decoded = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString(
      "utf-8",
    );
    expect(decoded).toBe(html);
  });

  it("RFC 2047 encodes a non-ASCII subject", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@example.com"],
      subject: "Réunion 会議",
      html: "<p>x</p>",
    });
    const { headers } = parts(raw);
    expect(headers).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    // The decoded encoded-word should equal the original subject.
    const m = headers.match(/Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/);
    expect(m).not.toBeNull();
    expect(Buffer.from(m![1], "base64").toString("utf-8")).toBe("Réunion 会議");
  });

  it("formats a display name and encodes it when non-ASCII", () => {
    const ascii = buildRawMessage({
      from: { email: "me@x.com", name: "Wildflower Team" },
      to: ["a@example.com"],
      subject: "s",
      html: "<p>x</p>",
    });
    expect(parts(ascii).headers).toContain(
      "From: Wildflower Team <me@x.com>",
    );

    const nonAscii = buildRawMessage({
      from: { email: "me@x.com", name: "Café" },
      to: ["a@example.com"],
      subject: "s",
      html: "<p>x</p>",
    });
    expect(parts(nonAscii).headers).toMatch(
      /From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <me@x\.com>/,
    );
  });

  it("includes threading headers when provided", () => {
    const raw = buildRawMessage({
      from: "me@x.com",
      to: ["a@example.com"],
      subject: "Re: thread",
      html: "<p>x</p>",
      inReplyTo: "<abc@mail.gmail.com>",
      references: "<abc@mail.gmail.com>",
    });
    const { headers } = parts(raw);
    expect(headers).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(headers).toContain("References: <abc@mail.gmail.com>");
  });
});
