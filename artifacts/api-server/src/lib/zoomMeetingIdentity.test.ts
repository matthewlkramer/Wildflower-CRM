import { describe, expect, it } from "vitest";
import {
  parseZoomMeetingEvent,
  zoomMeetingIdFromInvite,
} from "./zoomMeetingIdentity";

const id = "12345678901";
const now = Date.parse("2026-11-11T18:00:00Z");
const meeting = {
  id,
  uuid: "/WfZoom//t9==",
  host_id: "wildflower-host",
  host_email: "Staff@wildflower.example",
  type: 8,
};
const parse = (event: string, object: object, account = "wildflower") =>
  parseZoomMeetingEvent(
    event,
    { account_id: account, object },
    now,
    "wildflower",
    now,
  );

describe("Zoom meeting identity", () => {
  it("identifies an exact Zoom join link and excludes lookalike hosts and conflicting links", () => {
    expect(
      zoomMeetingIdFromInvite(
        `Join <a href="https://us02web.zoom.us/j/${id}?pwd=123">Zoom</a>`,
      ),
    ).toBe(id);
    expect(
      zoomMeetingIdFromInvite(`https://zoom.us.example/j/${id}`),
    ).toBeNull();
    expect(
      zoomMeetingIdFromInvite(
        `https://zoom.us/j/${id}`,
        "https://zoom.us/j/12345678902",
      ),
    ).toBeNull();
  });

  it("requires the expected account and an identifiable CRM host for starts", () => {
    expect(parse("meeting.started", meeting)).toMatchObject({
      kind: "started",
      meetingId: id,
      hostEmail: "staff@wildflower.example",
    });
    expect(parse("meeting.started", meeting, "another-account")).toBeNull();
    expect(parse("meeting.started", { ...meeting, host_email: "" })).toBeNull();
    expect(
      parse("meeting.participant_joined", {
        ...meeting,
        participant: { email: "" },
      }),
    ).toBeNull();
  });

  it("accepts the occurrence identifier from a durable text transcript event only", () => {
    const transcript = {
      host_id: meeting.host_id,
      meeting_id: Number(id),
      meeting_uuid: meeting.uuid,
      attach_type: "durable_transcript",
    };
    expect(parse("meeting.aic_transcript_completed", transcript)).toMatchObject(
      { kind: "transcript", meetingId: id, uuid: meeting.uuid },
    );
    expect(
      parse("meeting.aic_transcript_completed", {
        ...transcript,
        attach_type: "summary",
      }),
    ).toBeNull();
    expect(parse("recording.completed", meeting)).toBeNull();
  });
});
