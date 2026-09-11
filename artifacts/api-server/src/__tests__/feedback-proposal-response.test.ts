import { describe, expect, it } from "vitest";
import { parseFeedbackProposalResponse } from "../lib/proposeFeedback";

const validToolInput = {
  title: "Add a visible retry action",
  summary: "Let administrators retry a failed generation.",
  userExperience: ["An administrator sees retry status."],
  implementationSteps: ["Use the existing generation queue."],
  likelyCodeAreas: [{ area: "Feedback API", rationale: "Owns generation." }],
  acceptanceCriteria: ["A failed proposal can be retried."],
  testPlan: ["Add a focused API test."],
  risksAndOpenQuestions: [],
  implementationBrief: "Inspect the queue and add the smallest safe retry path.",
};

function toolResponse(
  input: unknown,
  stopReason: string | null = "tool_use",
) {
  return {
    stop_reason: stopReason,
    content: [
      {
        type: "tool_use",
        name: "propose_feedback_implementation",
        input,
      },
    ],
  };
}

describe("feedback proposal AI response parsing", () => {
  it("parses a complete forced-tool response", () => {
    const result = parseFeedbackProposalResponse(toolResponse(validToolInput));

    expect(result.error).toBeNull();
    expect(result.proposal).toMatchObject({
      title: "Add a visible retry action",
      acceptanceCriteria: ["A failed proposal can be retried."],
    });
    expect(result.diagnostic).toMatchObject({
      stopReason: "tool_use",
      contentBlockCount: 1,
      contentBlockTypes: ["tool_use"],
      matchingToolUseCount: 1,
      matchingToolInputs: ["object"],
    });
  });

  it("records safe metadata when output reaches its token limit", () => {
    const incomplete = { ...validToolInput, implementationBrief: "" };
    const result = parseFeedbackProposalResponse(
      toolResponse(incomplete, "max_tokens"),
    );

    expect(result.proposal).toBeNull();
    expect(result.error).toContain("output limit");
    expect(result.diagnostic).toEqual(
      expect.objectContaining({
        stopReason: "max_tokens",
        matchingToolUseCount: 1,
        missingCoreFields: ["implementationBrief"],
      }),
    );
  });

  it("rejects non-tool, wrong-tool, and malformed tool inputs without exposing content", () => {
    for (const response of [
      { stop_reason: "end_turn", content: [{ type: "text", text: "nope" }] },
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "other_tool", input: validToolInput }],
      },
      toolResponse(null),
      toolResponse(["not", "an", "object"]),
      { stop_reason: "unknown_provider_value", content: null },
    ]) {
      const result = parseFeedbackProposalResponse(response);
      expect(result.proposal).toBeNull();
      expect(result.error).toContain("incomplete");
      expect(JSON.stringify(result.diagnostic)).not.toContain("nope");
    }
  });

  it("accepts a complete matching tool block after an incomplete one", () => {
    const result = parseFeedbackProposalResponse({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "propose_feedback_implementation",
          input: { ...validToolInput, title: "" },
        },
        {
          type: "tool_use",
          name: "propose_feedback_implementation",
          input: validToolInput,
        },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.proposal?.title).toBe("Add a visible retry action");
    expect(result.diagnostic.matchingToolUseCount).toBe(2);
    expect(result.diagnostic.missingCoreFields).toEqual(["title"]);
  });
});