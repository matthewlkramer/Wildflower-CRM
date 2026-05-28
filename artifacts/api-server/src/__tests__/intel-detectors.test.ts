import { describe, it, expect } from "vitest";
import {
  extractGrantOpportunities,
  parseAutoResponderMove,
  parseEmailSignature,
} from "../lib/intelDetectors";

// ──────────────────────────────────────────────────────────────────
// Grant opportunity suppression
// ──────────────────────────────────────────────────────────────────

describe("extractGrantOpportunities — suppression rules", () => {
  it("surfaces a genuine new RFP with a future deadline", () => {
    const items = extractGrantOpportunities(
      "Request for Proposals: Early Childhood Education Grant",
      [
        "The Acme Family Foundation is now accepting applications.",
        "Grant awards range from $25,000 to $100,000 in funding.",
        "Application deadline: December 15, 2099.",
        "Apply at https://acme.org/apply",
      ].join("\n\n"),
      null,
      "grants@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items.length).toBeGreaterThan(0);
  });

  it("suppresses grant WINNER announcements (subject)", () => {
    const items = extractGrantOpportunities(
      "Congratulations to our 2025 grantees!",
      "We are proud to announce our 2025 grantees. Meet the recipients below.",
      null,
      "news@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items).toHaveLength(0);
  });

  it("suppresses a winner announcement even when it mentions grant keywords", () => {
    const items = extractGrantOpportunities(
      "Announcing our 2025 grant recipients",
      "Congratulations to our 2025 grantees! Each grant award of $50,000 will support their work this grant cycle. Meet the recipients below.",
      null,
      "news@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items).toHaveLength(0);
  });

  it("still surfaces an email that announces winners AND opens a new round", () => {
    const items = extractGrantOpportunities(
      "2025 grantees announced — 2026 applications now open",
      "Congratulations to our 2025 grantees! We are now accepting applications for the 2026 cycle, with grant awards up to $50,000. Apply by March 1, 2099.",
      null,
      "grants@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items.length).toBeGreaterThan(0);
  });

  it("suppresses vendor-procurement RFPs (sender is hiring)", () => {
    const items = extractGrantOpportunities(
      "Request for Proposals: seeking a vendor for website redesign",
      "We are seeking a vendor to provide services. See the scope of work and submit a bid.",
      null,
      "procurement@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items).toHaveLength(0);
  });

  it("suppresses promo / event-registration blasts", () => {
    const items = extractGrantOpportunities(
      "Register now: our annual fundraising gala",
      "Reserve your seat today! Early bird tickets are on sale now.",
      null,
      "events@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items).toHaveLength(0);
  });

  it("suppresses opportunities whose deadline already passed (explicit year)", () => {
    const items = extractGrantOpportunities(
      "Grant opportunity: Community Fund",
      "The Community Fund grant offers up to $50,000 in funding. Application deadline: January 15, 2020.",
      null,
      "grants@acme.org",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(items).toHaveLength(0);
  });

  it("does NOT suppress when the deadline has no explicit year", () => {
    const items = extractGrantOpportunities(
      "Grant opportunity: Community Fund",
      "The Community Fund grant offers up to $50,000 in funding. Application deadline: January 15.",
      null,
      "grants@acme.org",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(items.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Auto-responder move detection
// ──────────────────────────────────────────────────────────────────

describe("parseAutoResponderMove — OOO vs. genuine move", () => {
  it("ignores a plain out-of-office reply", () => {
    const move = parseAutoResponderMove(
      "I am out of office until Monday with limited access to my email. For urgent matters, please email my colleague at jane@acme.org.",
      null,
    );
    expect(move).toBeNull();
  });

  it("surfaces a genuine departure", () => {
    const move = parseAutoResponderMove(
      "I no longer work at Acme Foundation. I have joined Beta Capital. Please reach me at me@beta.com.",
      null,
    );
    expect(move).not.toBeNull();
    expect(move?.leftCompany).toMatch(/Acme/);
  });

  it("does not surface a bare forwarding address alone", () => {
    const move = parseAutoResponderMove(
      "Thanks for your email. Please contact me at newaddress@acme.org going forward.",
      null,
    );
    expect(move).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Signature phone parsing
// ──────────────────────────────────────────────────────────────────

describe("parseEmailSignature — phone heuristics", () => {
  it("parses a real US phone with separators", () => {
    const sig = parseEmailSignature(
      ["Jane Doe", "Director of Development", "Acme Foundation", "(415) 555-1234"].join("\n"),
      null,
    );
    expect(sig?.phone).toBeTruthy();
  });

  it("does not treat a long bare digit run (e.g. a Zoom id) as a phone", () => {
    const sig = parseEmailSignature(
      ["Jane Doe", "Director of Development", "Acme Foundation", "Meeting ID 88012345678"].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });

  it("does not treat a year range as a phone", () => {
    const sig = parseEmailSignature(
      ["Jane Doe", "Trustee", "Acme Foundation", "Serving the community since 2001"].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });
});
