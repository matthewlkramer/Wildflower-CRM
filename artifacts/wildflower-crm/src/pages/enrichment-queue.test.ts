import { describe, expect, it } from "vitest";
import {
  EMPLOYER_SOURCE,
  bulkFailureMap,
  enrichmentScopeKey,
  isDefaultEnrichmentSelection,
} from "./enrichment-queue";

describe("enrichment queue review helpers", () => {
  it("does not select employer-office evidence by default", () => {
    expect(
      isDefaultEnrichmentSelection({
        viewerCanResolve: true,
        sourceLabel: EMPLOYER_SOURCE,
      }),
    ).toBe(false);
    expect(
      isDefaultEnrichmentSelection({
        viewerCanResolve: true,
        sourceLabel: "Direct address",
      }),
    ).toBe(true);
  });

  it("keeps unauthorized rows out of the default selection", () => {
    expect(
      isDefaultEnrichmentSelection({
        viewerCanResolve: false,
        sourceLabel: "Direct address",
      }),
    ).toBe(false);
  });

  it("preserves mixed bulk failures for per-row reporting", () => {
    expect(
      bulkFailureMap([
        { id: "accepted", success: true },
        { id: "stale", success: false, message: "The value changed." },
        { id: "forbidden", success: false, error: "Owner required." },
      ]),
    ).toEqual({
      stale: "The value changed.",
      forbidden: "Owner required.",
    });
  });

  it("changes the selection scope when a filter or page changes", () => {
    const scope = {
      fieldName: "regionIds",
      sourceLabel: "",
      entityType: "all",
      ownerUserId: "all",
      confidence: "all",
      page: 1,
    };
    expect(enrichmentScopeKey(scope)).not.toBe(
      enrichmentScopeKey({ ...scope, page: 2 }),
    );
    expect(enrichmentScopeKey(scope)).not.toBe(
      enrichmentScopeKey({ ...scope, sourceLabel: "Direct address" }),
    );
  });
});
