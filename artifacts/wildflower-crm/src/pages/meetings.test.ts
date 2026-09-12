import { describe, expect, it } from "vitest";
import {
  MEETING_HISTORY_DAYS,
  meetingHistoryStart,
  shouldShowNoNotesAction,
} from "./meetings";
import { newMeetingWorkspaceHref } from "@/components/meeting-launcher-dialog";

describe("meetings history window", () => {
  it("starts exactly 60 days before the page load time", () => {
    const now = new Date("2026-09-09T18:30:00.000Z");

    expect(MEETING_HISTORY_DAYS).toBe(60);
    expect(meetingHistoryStart(now)).toBe("2026-07-11T18:30:00.000Z");
  });
});

describe("meetings list actions", () => {
  it("shows No notes for a meeting that has no notes", () => {
    expect(shouldShowNoNotesAction({ hasMeetingNotes: false })).toBe(true);
  });

  it("does not show No notes after meeting notes exist", () => {
    expect(shouldShowNoNotesAction({ hasMeetingNotes: true })).toBe(false);
  });
});

describe("new meeting launcher", () => {
  it("opens a draft workspace for the selected CRM contact", () => {
    expect(
      newMeetingWorkspaceHref({
        kind: "person",
        id: "person-123",
        label: "A donor name that does not belong in the URL",
      }),
    ).toBe("/meetings/new?contactKind=person&contactId=person-123");
  });
});
