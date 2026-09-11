import { describe, expect, it } from "vitest";
import {
  inferFeedbackCodeAreas,
  projectFeedbackContext,
} from "../lib/proposeFeedback";

describe("feedback proposal context", () => {
  it("maps the reported page to grounded CRM areas", () => {
    expect(inferFeedbackCodeAreas("/newsletter?audience=unsubscribed")).toEqual(
      ["Newsletter UI", "Newsletter API", "Flodesk integration"],
    );
    expect(inferFeedbackCodeAreas("/trip-planner/plan_123")).toContain(
      "Trip planner UI",
    );
    expect(inferFeedbackCodeAreas("/brand-new-area")).toEqual([
      "Relevant web page",
      "Relevant API route",
      "OpenAPI contract and tests",
    ]);
  });

  it("keeps reproduction state while stripping browser fingerprint data", () => {
    const projected = projectFeedbackContext({
      capturedAt: "2026-09-10T12:00:00.000Z",
      browser: {
        userAgent: "sensitive browser fingerprint",
        language: "en-US",
      },
      viewport: { width: 1440, height: 900 },
      activeTabs: ["Giving", "Pipeline"],
      activeControls: ["Status: Open"],
      controls: [
        { label: "Search", value: "Scott Cook", kind: "textbox" },
      ],
      visibleTestIds: ["proposal-row-feedback_123"],
    });

    expect(projected).toMatchObject({
      viewport: { width: 1440, height: 900 },
      activeTabs: ["Giving", "Pipeline"],
      controls: [
        { label: "Search", value: "Scott Cook", kind: "textbox" },
      ],
    });
    expect(projected).not.toHaveProperty("browser");
    expect(JSON.stringify(projected)).not.toContain("sensitive browser");
  });
});
