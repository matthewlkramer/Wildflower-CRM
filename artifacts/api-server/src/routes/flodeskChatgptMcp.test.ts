import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  plan: vi.fn(),
  importPage: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("../lib/flodeskMcp", () => ({
  planFlodeskCampaignEngagement: bridge.plan,
  importFlodeskRecipientPage: bridge.importPage,
  completeFlodeskEngagementBridgeRun: bridge.complete,
}));

import {
  FLODESK_CHATGPT_TOOLS,
  handleFlodeskChatgptMcpRequest,
  hasValidFlodeskChatgptMcpToken,
} from "./flodeskChatgptMcp";

function requestWithAuthorization(value: string | undefined): Request {
  return {
    get(name: string) {
      return name.toLowerCase() === "authorization" ? value : undefined;
    },
  } as Request;
}

describe("Flodesk ChatGPT MCP protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advertises the planning, page import, and completion tools", async () => {
    const response = await handleFlodeskChatgptMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: FLODESK_CHATGPT_TOOLS },
    });
  });

  it("normalizes campaign percentages before planning", async () => {
    bridge.plan.mockImplementation(async (campaigns) => ({
      campaignsChecked: campaigns.length,
      dueCampaigns: campaigns,
    }));

    const response = await handleFlodeskChatgptMcpRequest({
      jsonrpc: "2.0",
      id: "plan-1",
      method: "tools/call",
      params: {
        name: "plan_flodesk_engagement_sync",
        arguments: {
          campaigns: [
            {
              providerCampaignId: "email_123",
              subject: "September Seedlings",
              sentAt: "2026-09-14T15:00:00Z",
              openRate: 51,
              clickRate: 4.5,
            },
          ],
        },
      },
    });

    expect(bridge.plan).toHaveBeenCalledWith([
      expect.objectContaining({ openRate: 0.51, clickRate: 0.045 }),
    ]);
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "plan-1",
      result: {
        structuredContent: {
          campaignsChecked: 1,
          dueCampaigns: [
            {
              providerCampaignId: "email_123",
              sentAt: "2026-09-14T15:00:00.000Z",
            },
          ],
        },
      },
    });
  });

  it("normalizes exact recipient email identity and preserves final-page state", async () => {
    bridge.importPage.mockResolvedValue({
      campaignId: "flodesk:mcp:email_123",
      providerCampaignId: "email_123",
      engagementRecordsUpserted: 1,
      linkedRecords: 1,
      unmatchedRecords: 0,
      campaignCompleted: true,
    });

    await handleFlodeskChatgptMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "import_flodesk_recipient_page",
        arguments: {
          campaign: {
            providerCampaignId: "email_123",
            subject: "September Seedlings",
            sentAt: "2026-09-14T15:00:00Z",
          },
          recipients: [
            {
              email: "Donor@Example.org",
              opened: true,
              totalOpens: 0,
              clicked: true,
              totalClicks: 0,
              clickedLinks: ["https://wildflowerschools.org/story"],
            },
          ],
          finalPage: true,
        },
      },
    });

    expect(bridge.importPage).toHaveBeenCalledWith(
      expect.objectContaining({
        finalPage: true,
        recipients: [
          expect.objectContaining({
            email: "donor@example.org",
            totalOpens: 1,
            totalClicks: 1,
          }),
        ],
      }),
    );
  });

  it("compares the configured bearer token without accepting near matches", () => {
    process.env["FLODESK_CHATGPT_MCP_AUTH_TOKEN"] = "expected-secret";
    expect(
      hasValidFlodeskChatgptMcpToken(
        requestWithAuthorization("Bearer expected-secret"),
      ),
    ).toBe(true);
    expect(
      hasValidFlodeskChatgptMcpToken(
        requestWithAuthorization("Bearer expected-secrex"),
      ),
    ).toBe(false);
  });
});
