import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anthropic SDK BEFORE importing the module under test so the
// import picks up the stub. We exercise the response-shaping logic —
// JSON extraction, fence stripping, action-item normalization,
// truncation — without making a real model call. `vi.hoisted` is
// required because `vi.mock` is hoisted above imports and would
// otherwise reference an undeclared `create`.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create } },
}));

import { summarizeMeeting } from "../lib/summarizeMeeting";

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

describe("summarizeMeeting", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("returns placeholder for empty transcript without calling the model", async () => {
    const out = await summarizeMeeting("   ");
    expect(create).not.toHaveBeenCalled();
    expect(out.summary).toBe("(no summary available)");
    expect(out.actionItems).toEqual([]);
  });

  it("includes the closing exchange and separates reviewer and relationship context from meeting evidence", async () => {
    create.mockResolvedValue(textResponse('{"summary":"ok","actionItems":[]}'));
    const transcript = "Opening. " + "Discussion. ".repeat(6500) + "The pre-read has the report. I'll think about fit.";
    await summarizeMeeting(transcript, { relationship: "Earlier correspondence", reviewer: "Matt thought this was genuine" });
    const prompt = create.mock.calls[0][0];
    expect(JSON.parse(prompt.messages[0].content)).toEqual({
      meetingSources: transcript,
      sharedRelationshipHistory: "Earlier correspondence",
      staffReviewerObservations: "Matt thought this was genuine",
    });
    expect(prompt.system).toContain("supersedes an earlier offer");
    expect(prompt.system).toContain("volunteered and owned by a funder");
  });

  it("retains waiting and shared evidence while suppressing a mislabeled task and an obsolete resend", async () => {
    create.mockResolvedValue(textResponse(JSON.stringify({
      summary: "They will review the plan.",
      actionItems: [
        { title: "Send outcomes report", ownerSide: "internal" },
        { title: "Prepare the growth plan", ownerSide: "internal" },
        { title: "Assess fit", assigneeName: "Pat Funder", ownerSide: "internal" },
      ],
      followUps: [
        { kind: "shared", title: "Outcomes report", evidence: "The report is linked in the pre-read we sent", evidenceEmailId: "email-1", readStatus: "unread", supersedesTitles: ["Send outcomes report"] },
        { kind: "waiting", title: "Consider fit", ownerName: "Pat Funder", evidence: "I will think through how this could fit", dependsOnTitle: "Prepare the growth plan" },
        { kind: "waiting", title: "Approve award", evidence: "Invented funding promise", evidenceEmailId: "unknown" },
      ],
    })));
    const out = await summarizeMeeting("Pat: I will think through how this could fit.", {
      relationship: JSON.stringify({ sharedEmails: [{ id: "email-1", excerpt: "The report is linked in the pre-read we sent", direction: "sent" }] }),
    });
    expect(out.actionItems.map((item) => item.title)).toEqual(["Prepare the growth plan"]);
    expect(out.followUps).toEqual([
      expect.objectContaining({ kind: "shared", evidenceEmailId: "email-1", readStatus: "unread" }),
      expect.objectContaining({ kind: "waiting", dependsOnTitle: "Prepare the growth plan" }),
    ]);
  });

  it("parses well-formed JSON output", async () => {
    create.mockResolvedValue(
      textResponse(
        JSON.stringify({
          summary: "Discussed Q3 grant timeline.",
          actionItems: [
            { title: "Send LOI by Friday", assigneeName: "Alex", dueDate: "2026-06-05", ownerSide: "internal" },
            { title: "Schedule follow-up", assigneeName: null, dueDate: null, ownerSide: "internal" },
            { title: "Review the plan", assigneeName: "Funder", dueDate: null, ownerSide: "external" },
          ],
        }),
      ),
    );
    const out = await summarizeMeeting("transcript body");
    expect(out.summary).toBe("Discussed Q3 grant timeline.");
    expect(out.actionItems).toHaveLength(2);
    expect(out.actionItems[0].dueDate).toBe("2026-06-05");
    expect(out.actionItems[1].assigneeName).toBeNull();
  });

  it("strips ```json fences", async () => {
    create.mockResolvedValue(
      textResponse(
        '```json\n{"summary": "ok", "actionItems": []}\n```',
      ),
    );
    const out = await summarizeMeeting("x");
    expect(out.summary).toBe("ok");
  });

  it("drops items with no title and rejects non-ISO dueDate", async () => {
    create.mockResolvedValue(
      textResponse(
        JSON.stringify({
          summary: "s",
          actionItems: [
            { title: "Keep me", dueDate: "next Tuesday", ownerSide: "internal" },
            { title: "  ", dueDate: "2026-06-05" },
            { assigneeName: "no title" },
          ],
        }),
      ),
    );
    const out = await summarizeMeeting("x");
    expect(out.actionItems).toHaveLength(1);
    expect(out.actionItems[0].title).toBe("Keep me");
    expect(out.actionItems[0].dueDate).toBeNull();
  });

  it("returns placeholder on model error", async () => {
    create.mockRejectedValue(new Error("rate limit"));
    const out = await summarizeMeeting("x");
    expect(out.summary).toBe("(summary unavailable)");
    expect(out.actionItems).toEqual([]);
  });

  it("returns placeholder when the model emits non-JSON", async () => {
    create.mockResolvedValue(textResponse("I cannot help with that."));
    const out = await summarizeMeeting("x");
    expect(out.summary).toBe("(summary unavailable)");
  });

  it("caps action items at six", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Item ${i}`, ownerSide: "internal" }));
    create.mockResolvedValue(
      textResponse(JSON.stringify({ summary: "s", actionItems: many })),
    );
    const out = await summarizeMeeting("x");
    expect(out.actionItems).toHaveLength(6);
  });
});
