import { describe, it, expect } from "vitest";
import {
  CreateMeetingNoteBodyRefined,
  validateMeetingLinkInvariants,
  MEETING_LINK_MESSAGE,
} from "@workspace/api-zod";

describe("meeting-note links", () => {
  it("allows a person and organization together, with no primary", () => {
    expect(
      validateMeetingLinkInvariants({
        personIds: ["p1"],
        organizationIds: ["o1"],
      }),
    ).toEqual([]);
  });

  it("allows multiple people and organizations", () => {
    expect(
      validateMeetingLinkInvariants({
        personIds: ["p1", "p2"],
        organizationIds: ["o1", "o2"],
      }),
    ).toEqual([]);
  });

  it("allows a calendar-only note before CRM records are matched", () => {
    expect(
      validateMeetingLinkInvariants({ calendarEventId: "event-1" }),
    ).toEqual([]);
  });

  it("rejects a standalone note without a CRM link", () => {
    expect(validateMeetingLinkInvariants({})[0]?.message).toBe(
      MEETING_LINK_MESSAGE,
    );
  });

  it("rejects blank and duplicate IDs", () => {
    expect(
      validateMeetingLinkInvariants({ personIds: ["p1", "p1"] }),
    ).toHaveLength(1);
    expect(
      validateMeetingLinkInvariants({ organizationIds: [" "] }),
    ).toHaveLength(1);
  });
});

describe("meeting workspace content", () => {
  const base = {
    personIds: ["p1"],
    organizationIds: ["o1"],
    title: "Donor call",
  };

  it("accepts live staff notes linked to both a person and organization", () => {
    expect(
      CreateMeetingNoteBodyRefined.safeParse({
        ...base,
        manualNotes: "Discussed a possible fall visit.",
      }).success,
    ).toBe(true);
  });

  it("accepts a calendar-only OCR note", () => {
    expect(
      CreateMeetingNoteBodyRefined.safeParse({
        calendarEventId: "event-1",
        artifacts: [
          {
            id: "artifact-1",
            kind: "handwritten_notes",
            objectPath: "/objects/uploads/note.jpg",
            fileName: "note.jpg",
            mimeType: "image/jpeg",
            sizeBytes: 1200,
            transcript: "Call in October.",
            createdAt: "2026-09-12T12:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("still rejects a record with no meeting content", () => {
    expect(CreateMeetingNoteBodyRefined.safeParse(base).success).toBe(false);
  });
});
