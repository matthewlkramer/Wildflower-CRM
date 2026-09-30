import { describe, expect, it } from "vitest";
import { chooseAttendanceWinner, sourceWindowKey } from "../lib/conferenceTypeMerge";

describe("conference type merge collision decisions", () => {
  it("keeps the strongest attendance evidence and prefers the target event on a tie", () => {
    const rows = [
      { id: "source", conferenceEventId: "source-event", status: "confirmed" },
      { id: "target", conferenceEventId: "target-event", status: "confirmed" },
      { id: "possible", conferenceEventId: "target-event", status: "possible" },
    ];

    expect(chooseAttendanceWinner(rows, "target-event").id).toBe("target");
    expect(chooseAttendanceWinner(rows.slice(1), "target-event").id).toBe("target");
  });

  it("suffixes a historical research window without changing its original key", () => {
    expect(sourceWindowKey("created", "source-event")).toBe("created:merged-from:source-event");
    expect(sourceWindowKey("created", "source-event", 2)).toBe("created:merged-from:source-event:2");
    expect(sourceWindowKey(null, "source-event")).toBeNull();
  });
});