import { describe, expect, it } from "vitest";
import {
  isFlodeskCampaignDue,
  parseFlodeskCampaigns,
  parseFlodeskRecipients,
} from "./flodeskMcp";

describe("Flodesk MCP normalization", () => {
  it("normalizes ranked email results", () => {
    const campaigns = parseFlodeskCampaigns({
      data: {
        emails: [
          {
            email_id: "email_123",
            email_name: "September Seedlings",
            sent_at: "2026-09-14T15:00:00Z",
            open_rate: "51%",
            click_rate: 4.5,
          },
        ],
      },
    });

    expect(campaigns).toEqual([
      expect.objectContaining({
        providerCampaignId: "email_123",
        subject: "September Seedlings",
        openRate: 0.51,
        clickRate: 0.045,
      }),
    ]);
  });

  it("normalizes recipient activity and clicked link objects", () => {
    const recipients = parseFlodeskRecipients({
      recipients: [
        {
          email_address: "Donor@Example.org",
          first_name: "Dora",
          delivered_at: "2026-09-14T15:01:00Z",
          opens: [{ opened_at: "2026-09-14T16:00:00Z" }],
          clicks: [
            {
              url: "https://wildflowerschools.org/story",
              clicked_at: "2026-09-14T16:05:00Z",
            },
          ],
        },
      ],
    });

    expect(recipients).toEqual([
      expect.objectContaining({
        email: "donor@example.org",
        opened: true,
        totalOpens: 1,
        clicked: true,
        totalClicks: 1,
        clickedLinks: ["https://wildflowerschools.org/story"],
      }),
    ]);
    expect(recipients[0]?.lastClickedAt?.toISOString()).toBe(
      "2026-09-14T16:05:00.000Z",
    );
  });
});

describe("Flodesk MCP campaign cadence", () => {
  const now = new Date("2026-09-15T09:00:00Z");

  it("refreshes a new campaign daily for its first two weeks", () => {
    expect(
      isFlodeskCampaignDue(
        {
          sentAt: new Date("2026-09-10T09:00:00Z"),
          lastEngagementSyncedAt: new Date("2026-09-14T08:00:00Z"),
        },
        now,
      ),
    ).toBe(true);
  });

  it("refreshes older campaigns weekly", () => {
    expect(
      isFlodeskCampaignDue(
        {
          sentAt: new Date("2026-08-01T09:00:00Z"),
          lastEngagementSyncedAt: new Date("2026-09-10T09:00:00Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isFlodeskCampaignDue(
        {
          sentAt: new Date("2026-08-01T09:00:00Z"),
          lastEngagementSyncedAt: new Date("2026-09-08T09:00:00Z"),
        },
        now,
      ),
    ).toBe(true);
  });
});
