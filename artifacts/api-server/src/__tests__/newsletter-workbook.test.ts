import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseNewsletterWorkbook } from "../lib/newsletterWorkbook";

const standardHeader = [
  "email_address",
  "first_name",
  "last_name",
  "email_preview_link",
  "delivered",
  "opened",
  "last_opened",
  "total_times_opened",
  "clicked",
];

function addSheet(book: XLSX.WorkBook, name: string, values: unknown[][]) {
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(values), name);
}

describe("parseNewsletterWorkbook", () => {
  it("imports campaign evidence and applies the latest audience-state precedence", () => {
    const book = XLSX.utils.book_new();
    const dashboard: unknown[][] = [
      [
        "Date Sent",
        "Day of the Week",
        "Time",
        "Subject line",
        "Open Rate",
        "Click through rate",
      ],
    ];
    for (const [date, subject] of [
      ["February 11, 2025", "February"],
      ["May 23, 2025", "May"],
      ["August 27, 2025", "Seedlings"],
      ["February 11, 2026", "Minnesota"],
      ["August 20, 2026", "Seedlings 2026"],
    ]) {
      dashboard.push([date, "", "5:00 am CT", subject, 0.6, 0.05]);
    }
    while (dashboard.length < 20) dashboard.push([]);
    dashboard.push(["Unsubscribes from August 2026"]);
    dashboard.push(["optout@example.org", "Aug 21"]);
    dashboard.push(["Click throughs to something"]);
    addSheet(book, "Newsletter analytics dashboard", dashboard);
    addSheet(book, "FINAL LIST AUG 2026 (Flodesk)", [
      ["First Name", "Email"],
      ["Active", "active@example.org"],
      ["Optout", "optout@example.org"],
    ]);
    addSheet(book, "Unsubscribe", [["Sort"], ["EMAIL", "UNSUBSCRIBED"]]);
    addSheet(book, "Bounced", [
      ["EMAILBOUNCED"],
      ["oldbounce@example.org"],
      ["Nov 17"],
      ["active@example.org"],
      ["Nov 17"],
    ]);

    const recipient = [
      "active@example.org",
      "Active",
      "Reader",
      "https://view.flodesk.com/email",
      new Date("2026-01-01T12:00:00Z"),
      true,
      new Date("2026-01-01T13:00:00Z"),
      2,
      false,
    ];
    addSheet(book, "February Newsletter Analytics", [
      ["All recipients who opened the email today"],
      [
        "email_address",
        "first_name",
        "last_opened",
        "total_times_opened",
        "clicked",
        null,
        null,
      ],
      [
        "active@example.org",
        "Active",
        new Date("2025-02-11T12:00:00Z"),
        1,
        false,
        null,
        "active@example.org",
      ],
    ]);
    addSheet(book, "May 2025 analytics ", [standardHeader, recipient]);
    addSheet(book, "2025 Seedlings Newsletter Analy", [
      ["Clicked through to Seedlings"],
      ["active@example.org"],
      ["Opened Email"],
      standardHeader,
      recipient,
    ]);
    addSheet(book, "Analytics Feb 2026", [standardHeader, recipient]);
    addSheet(book, "August 2026 Analytics", [
      ["Click Throughs"],
      ["link_clicked", "email_address", "total_clicks", "last_clicked"],
      [
        "https://example.org/story",
        "active@example.org",
        3,
        new Date("2026-08-21T12:00:00Z"),
      ],
      ["Opened"],
      standardHeader,
      recipient,
    ]);

    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    const parsed = parseNewsletterWorkbook(buffer);

    expect(parsed.campaigns).toHaveLength(5);
    expect(parsed.currentActiveEmails).toEqual(["active@example.org"]);
    expect(parsed.currentUnsubscribedEmails).toEqual(["optout@example.org"]);
    expect(parsed.bouncedEmailsToInvalidate).toEqual(["oldbounce@example.org"]);
    expect(
      parsed.engagement.some(
        (row) =>
          row.campaignId === "flodesk:2026-08-20" && row.totalClicks === 3,
      ),
    ).toBe(true);
  });
});
