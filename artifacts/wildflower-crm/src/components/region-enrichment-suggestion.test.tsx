import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegionEnrichmentSuggestion } from "./region-enrichment-suggestion";

const mocks = vi.hoisted(() => ({
  suggestion: null as null | Record<string, unknown>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetOrganizationQueryKey: () => ["organization"],
  getGetPersonQueryKey: () => ["person"],
  getListOrganizationEnrichmentSuggestionsQueryKey: () => ["org-suggestions"],
  getListOrganizationsQueryKey: () => ["organizations"],
  getListPeopleQueryKey: () => ["people"],
  getListPersonEnrichmentSuggestionsQueryKey: () => ["person-suggestions"],
  useListOrganizationEnrichmentSuggestions: () => ({
    data: { data: [] },
    isLoading: false,
  }),
  useListPersonEnrichmentSuggestions: () => ({
    data: { data: mocks.suggestion ? [mocks.suggestion] : [] },
    isLoading: false,
  }),
  useResolveEnrichmentSuggestion: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useRunOrganizationEnrichment: () => ({ mutate: vi.fn(), isPending: false }),
  useRunPersonEnrichment: () => ({ mutate: vi.fn(), isPending: false }),
}));

describe("RegionEnrichmentSuggestion", () => {
  beforeEach(() => {
    mocks.suggestion = null;
  });

  it("offers an explicit enrichment run for a blank field", () => {
    const html = renderToStaticMarkup(
      createElement(RegionEnrichmentSuggestion, {
        entityType: "person",
        entityId: "person-1",
        eligible: true,
      }),
    );
    expect(html).toContain("Check CRM suggestions");
    expect(html).toContain("Nothing is changed automatically");
  });

  it("shows provenance and owner review actions for a pending suggestion", () => {
    mocks.suggestion = {
      id: "suggestion-1",
      suggestedValue: { regionId: "region-mt", label: "Missoula, Montana" },
      sourceLabel: "Direct address",
      sourceDetail: "Missoula, MT 59801",
      viewerCanResolve: true,
    };
    const html = renderToStaticMarkup(
      createElement(RegionEnrichmentSuggestion, {
        entityType: "person",
        entityId: "person-1",
        eligible: true,
      }),
    );
    expect(html).toContain("Suggested");
    expect(html).toContain("Missoula, Montana");
    expect(html).toContain("Direct address");
    expect(html).toContain("Accept");
    expect(html).toContain("Dismiss");
  });
});
