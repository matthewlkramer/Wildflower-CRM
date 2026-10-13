import { describe, it, expect, vi, afterEach } from "vitest";
const create = vi.hoisted(() => vi.fn());
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create } },
  withRateLimitRetry: (fn: () => unknown) => fn(),
}));
vi.mock("../lib/aiConcurrency", () => ({
  aiProposalLimit: (fn: () => unknown) => fn(),
}));
import {
  groundedMeetingProposals,
  generateMeetingNextSteps,
} from "../lib/generateMeetingNextSteps";
afterEach(() => create.mockReset());
describe("explicit meeting task proposals", () => {
  it("rejects invented evidence and repeated titles, retaining valid dates only", () => {
    expect(
      groundedMeetingProposals(
        {
          proposals: [
            {
              title: "Send budget",
              evidence: "I need to send the budget",
              dueDate: "2026-10-20",
            },
            { title: "Send budget!", evidence: "I need to send the budget" },
            { title: "Organize a gala", evidence: "We should organize a gala" },
            {
              title: "Call Robin",
              evidence: "I will call Robin",
              dueDate: "2026-02-30",
            },
          ],
        },
        "I need to send the budget. I will call Robin.",
      ),
    ).toEqual([
      { title: "Send budget", description: null, dueDate: "2026-10-20" },
      { title: "Call Robin", description: null, dueDate: null },
    ]);
  });
  it("accepts zero proposals rather than manufacturing follow-ups", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: '{"proposals":[]}' }],
    });
    expect(
      await generateMeetingNextSteps(
        "We discussed the school and her interests.",
      ),
    ).toEqual([]);
    expect(create.mock.calls[0][0].system).toContain("Return zero proposals");
  });
  it("uses the shared CRM provider without requiring OpenAI config", async () => {
    create.mockResolvedValue({
      content: [
        {
          type: "text",
          text: '{"proposals":[{"title":"Send budget","evidence":"I need to send the budget"}]}',
        },
      ],
    });
    expect(
      await generateMeetingNextSteps("I need to send the budget."),
    ).toHaveLength(1);
  });
  it("reports malformed provider output as a retryable failure", async () => {
    create.mockResolvedValue({
      content: [{ type: "text", text: '{"tasks":[]}' }],
    });
    await expect(
      generateMeetingNextSteps("I need to send the budget."),
    ).rejects.toThrow("Your notes are saved");
  });
});
