import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gatherTaskSignals: vi.fn(),
  gatherMeetingPreparationSignals: vi.fn(),
  createMessage: vi.fn(),
}));

vi.mock("../lib/gatherTaskSignals", () => ({
  gatherTaskSignals: mocks.gatherTaskSignals,
  gatherMeetingPreparationSignals: mocks.gatherMeetingPreparationSignals,
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: mocks.createMessage } },
  withRateLimitRetry: (work: () => unknown) => work(),
}));

vi.mock("../lib/aiConcurrency", () => ({
  aiProposalLimit: (work: () => unknown) => work(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { generateRelationshipSummary } from "../lib/relationshipSummary";

const baseSignals = {
  entity: {
    kind: "organization",
    id: "org-1",
    name: "Example Foundation",
    priority: null,
    capacityRating: null,
    connectionStatus: null,
    enthusiasm: null,
    lastContacted: null,
    interactionCount: 0,
    tags: null,
    issuesGrants: true,
    interests: [],
    fundingRegionIds: ["massachusetts"],
  },
  recentGifts: [],
  openOpportunities: [],
  recentNotes: [],
  recentMeetings: [],
  recentCalendarEvents: [],
  recentEmails: [],
  recentMediaMentions: [],
  recentNewsletterEngagement: [],
};

describe("relationship summary context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatherTaskSignals.mockResolvedValue(baseSignals);
    mocks.gatherMeetingPreparationSignals.mockResolvedValue({
      ...baseSignals,
      schoolGeographySection:
        "Schools in Geographies of Interest\nExample School — Boston, MA",
      relevantWildflowerUpdates: [],
    });
    mocks.createMessage.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            summary: "Example Foundation has no recorded activity yet.",
            nextSteps: [],
          }),
        },
      ],
    });
  });

  it("keeps meeting-only school context out of record-page summaries", async () => {
    const result = await generateRelationshipSummary({
      organizationId: "org-1",
    });

    expect(mocks.gatherTaskSignals).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
    expect(mocks.gatherMeetingPreparationSignals).not.toHaveBeenCalled();
    expect(result?.summary).toBe(
      "Example Foundation has no recorded activity yet.",
    );
    expect(mocks.createMessage.mock.calls[0]?.[0]?.system).toContain(
      "Do not enumerate schools",
    );
  });

  it("includes school context in the single-meeting preparation response", async () => {
    const result = await generateRelationshipSummary({
      organizationId: "org-1",
      meetingPreparation: true,
    });

    expect(mocks.gatherMeetingPreparationSignals).toHaveBeenCalledWith({
      organizationId: "org-1",
      meetingPreparation: true,
    });
    expect(mocks.gatherTaskSignals).not.toHaveBeenCalled();
    expect(result?.summary).toContain("Example School — Boston, MA");
    expect(mocks.createMessage.mock.calls[0]?.[0]?.system).not.toContain(
      "Do not enumerate schools",
    );
  });
});
