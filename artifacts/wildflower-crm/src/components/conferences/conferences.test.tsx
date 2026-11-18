import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConferenceEventSummary, ConferenceResearchRequest } from "@workspace/api-client-react";
import { EventForm, groupConferenceEditions, latestCompletedDateProposal, speakerAddInput } from "@/pages/conferences";
import { conferenceError } from "./type-manager";

describe("conference date and administration UI", () => {
  it("groups editions by conference series and keeps each year's count", () => {
    const editions: ConferenceEventSummary[] = [
      { id: "gsv-25", conferenceTypeId: "gsv", conferenceTypeName: "ASU+GSV Summit",
        year: 2025, attendanceCount: 7, location: "San Diego", status: "completed", createdAt: "", updatedAt: "" },
      { id: "gsv-26", conferenceTypeId: "gsv", conferenceTypeName: "ASU+GSV Summit",
        year: 2026, attendanceCount: 12, status: "completed", createdAt: "", updatedAt: "" },
      { id: "other-26", conferenceTypeId: "other", conferenceTypeName: "Other conference",
        year: 2026, attendanceCount: 3, status: "completed", createdAt: "", updatedAt: "" },
    ];
    const series = groupConferenceEditions(editions, "");
    expect(series.map(([id]) => id)).toEqual(["gsv", "other"]);
    expect(series[0]?.[1].editions.map(({ year, attendanceCount }) => [year, attendanceCount]))
      .toEqual([[2026, 12], [2025, 7]]);
    expect(groupConferenceEditions(editions, "san diego")[0]?.[1].editions.map(({ id }) => id))
      .toEqual(["gsv-25"]);
  });

  it("asks for a start date or an explicit unknown-date research path", () => {
    const html = renderToStaticMarkup(createElement(EventForm, { types: [{ id: "type-1", displayName: "Learning Summit" }], pending: false, onSave: vi.fn(), onCancel: vi.fn() }));
    expect(html).toContain("Start date");
    expect(html).toContain("End date (optional)");
    expect(html).toContain("I don’t know — find the dates");
    expect(html).toContain("Create event");
  });

  it("surfaces server conflict detail for a protected deletion", () => {
    expect(conferenceError({ response: { data: { message: "Type still has events", details: { eventCount: 3 } } } })).toContain("eventCount");
  });

  it("requires explicit selection even for a single candidate and includes only chosen existing people", () => {
    const proposals = [
      { id: "ambiguous", candidatePersonIds: ["person-a", "person-b"], matchCandidates: [{ personId: "person-a", name: "Alex Lee" }, { personId: "person-b", name: "Alex Lee" }] },
      { id: "single", candidatePersonIds: ["person-c"], matchCandidates: [{ personId: "person-c", name: "Sam Kim" }] },
      { id: "new", candidatePersonIds: [], matchCandidates: [] },
    ];
    expect(speakerAddInput(proposals, ["single"], {})).toBeNull();
    expect(speakerAddInput(proposals, ["ambiguous", "single", "new"], { ambiguous: "person-b" })).toBeNull();
    expect(speakerAddInput(proposals, ["ambiguous"], { ambiguous: "different-person" })).toBeNull();
    expect(speakerAddInput(proposals, ["new"], {})).toEqual({ proposalIds: ["new"], personSelections: [] });
    expect(speakerAddInput(proposals, ["ambiguous", "single", "new"], { ambiguous: "person-b", single: "person-c" })).toEqual({
      proposalIds: ["ambiguous", "single", "new"],
      personSelections: [{ proposalId: "ambiguous", personId: "person-b" }, { proposalId: "single", personId: "person-c" }],
    });
  });

  it("blocks adding a possible match when candidate details are unavailable", () => {
    expect(speakerAddInput([{ id: "missing", candidatePersonIds: ["person-a"] }], ["missing"], { missing: "person-a" })).toBeNull();
  });

  it("shows the latest completed date proposal, not an older or unfinished run", () => {
    const run = (id: string, status: string, completedAt: string | null, proposedStartDate: string) => ({
      id, kind: "dates", status, completedAt, createdAt: "2025-01-01T00:00:00Z", proposedStartDate,
    }) as ConferenceResearchRequest;
    expect(latestCompletedDateProposal([
      run("newest", "completed", "2025-03-03T00:00:00Z", "2025-07-10"),
      run("running", "running", null, "2025-08-01"),
      run("oldest", "completed", "2025-02-01T00:00:00Z", "2025-07-01"),
    ])?.id).toBe("newest");
  });
});