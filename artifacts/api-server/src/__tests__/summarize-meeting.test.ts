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

  it("parses well-formed JSON output", async () => {
    create.mockResolvedValue(
      textResponse(
        JSON.stringify({
          summary: "Discussed Q3 grant timeline.",
          actionItems: [
            { title: "Send LOI by Friday", assigneeName: "Alex", dueDate: "2026-06-05" },
            { title: "Schedule follow-up", assigneeName: null, dueDate: null },
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
            { title: "Keep me", dueDate: "next Tuesday" },
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

  it("caps action items at 12", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Item ${i}` }));
    create.mockResolvedValue(
      textResponse(JSON.stringify({ summary: "s", actionItems: many })),
    );
    const out = await summarizeMeeting("x");
    expect(out.actionItems).toHaveLength(12);
  });
});
