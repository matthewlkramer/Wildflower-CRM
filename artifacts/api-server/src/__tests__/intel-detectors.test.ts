import { describe, it, expect } from "vitest";
import {
  extractGrantOpportunities,
  extractLinkedInJobChanges,
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

  it("ignores a Zoom dial-in block", () => {
    const sig = parseEmailSignature(
      [
        "Jane Doe",
        "Director of Development",
        "Acme Foundation",
        "Join Zoom Meeting",
        "https://zoom.us/j/123456789",
        "One tap mobile +1 301 715 8592,,123456789# US",
        "Dial by your location",
        "+1 301 715 8592 US (Washington DC)",
        "+1 312 626 6799 US (Chicago)",
        "Meeting ID: 123 456 789",
        "Passcode: 654321",
      ].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });

  it("ignores a Google Meet dial-in block", () => {
    const sig = parseEmailSignature(
      [
        "Bob Smith",
        "Program Officer",
        "Beta Foundation",
        "Join with Google Meet",
        "To join by phone dial +1 651-371-2940",
        "PIN: 123 456 789#",
      ].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });

  it("still detects a genuine personal phone alongside a Zoom block", () => {
    const sig = parseEmailSignature(
      [
        "Jane Doe",
        "Director of Development",
        "Acme Foundation",
        "Mobile: (415) 555-9876",
        "Join Zoom Meeting",
        "One tap mobile +1 301 715 8592,,123456789# US",
        "Dial by your location",
        "+1 312 626 6799 US (Chicago)",
      ].join("\n"),
      null,
    );
    expect(sig?.phone).toBeTruthy();
    expect(sig?.phone?.replace(/\D/g, "")).toContain("4155559876");
  });

  it("ignores a Zoom block with label-prefixed 'US: +1 …' dial-in lines", () => {
    // The real-world leaking shape: dial-in numbers carry a country/city
    // label so they don't start with a digit or '+'. The old parser closed
    // the block at the first such line and leaked the number as the phone.
    const sig = parseEmailSignature(
      [
        "Tanya Beja",
        "Director of Development",
        "Acme Foundation",
        "Join Zoom Meeting",
        "One tap mobile",
        "US: +1 646 931 3860",
        "Or dial:",
        "US: +1 312 626 6799",
        "Meeting ID: 812 3456 7890",
      ].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });

  it("ignores a Google Meet block with '(US) +1 …' and a following PIN line", () => {
    const sig = parseEmailSignature(
      [
        "Brandon Levin",
        "Program Officer",
        "Beta Foundation",
        "Join with Google Meet",
        "Join by phone",
        "(US) +1 302-317-2902",
        "PIN: 987 654 321#",
      ].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });

  it("ignores a bare dial-in number immediately followed by a PIN line", () => {
    const sig = parseEmailSignature(
      [
        "Sarah Lee",
        "Development Associate",
        "Gamma Trust",
        "+1 408 555 0199",
        "PIN: 555 111 222",
      ].join("\n"),
      null,
    );
    expect(sig?.phone ?? null).toBeNull();
  });

  it("still returns a labeled personal mobile even with a following dial-in block", () => {
    const sig = parseEmailSignature(
      [
        "Emily Chen",
        "Chief Advancement Officer",
        "Delta Foundation",
        "Direct: (617) 555-0142",
        "Join Zoom Meeting",
        "One tap mobile",
        "US: +1 646 931 3860",
        "Meeting ID: 812 3456 7890",
      ].join("\n"),
      null,
    );
    expect(sig?.phone).toBeTruthy();
    expect(sig?.phone?.replace(/\D/g, "")).toContain("6175550142");
  });
});

// ──────────────────────────────────────────────────────────────────
// LinkedIn job-change extraction
// ──────────────────────────────────────────────────────────────────

describe("extractLinkedInJobChanges", () => {
  it("extracts name, title, and company from a digest line", () => {
    const items = extractLinkedInJobChanges(
      "Jane Doe started a new position as Director of Partnerships at Acme Foundation\nView profile",
      null,
      null,
    );
    expect(items).toHaveLength(1);
    expect(items[0].personName).toBe("Jane Doe");
    expect(items[0].newTitle).toBe("Director of Partnerships");
    expect(items[0].newCompany).toBe("Acme Foundation");
  });

  it('extracts the "is now" form with a comma-bearing title', () => {
    const items = extractLinkedInJobChanges(
      "Massie Ritsch is now Executive Director, Media Relations at The College Board\nView profile",
      null,
      null,
    );
    expect(items).toHaveLength(1);
    expect(items[0].personName).toBe("Massie Ritsch");
    expect(items[0].newCompany).toBe("The College Board");
  });

  it("extracts a title-less position change across a wrapped line", () => {
    const items = extractLinkedInJobChanges(
      "John Q. Smith started a new\nposition at Beta Trust\nSee all updates",
      null,
      null,
    );
    expect(items).toHaveLength(1);
    expect(items[0].newCompany).toBe("Beta Trust");
    expect(items[0].newTitle).toBeNull();
  });

  // Regression: a LinkedIn digest containing long prose after "is now"
  // with no company terminator ("Gartner is now predicting that half of
  // all global organizations will soon require ...") sent the previous
  // patterns into catastrophic regex backtracking, pegging the event
  // loop and freezing the API server in dev AND production. The
  // detector must stay fast on arbitrarily long almost-matching prose.
  it("terminates quickly on long almost-matching prose (no hang)", () => {
    const prose =
      "Gartner is now predicting that half of all global organizations " +
      "will soon require skills assessments to counter the atrophy of " +
      "critical thinking across every industry and market segment ";
    const body =
      "You have 1 new invitation\n" +
      prose.repeat(60) +
      "\nMore news follows without any recognizable structure";
    const t0 = Date.now();
    const items = extractLinkedInJobChanges(body, null, "You have 1 new invitation");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);
    expect(Array.isArray(items)).toBe(true);
  });

  it("caps pathological input length instead of scanning it all", () => {
    const t0 = Date.now();
    const items = extractLinkedInJobChanges(
      ("A B is now " + "x".repeat(500) + " ").repeat(2000),
      null,
      null,
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(Array.isArray(items)).toBe(true);
  });
});
