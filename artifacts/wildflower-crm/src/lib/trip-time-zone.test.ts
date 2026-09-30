import { describe, expect, it } from "vitest";
import {
  formatTripDateTime,
  inferTripTimeZone,
  toZonedInput,
  zonedInputToIso,
} from "./trip-time-zone";

describe("trip time zones", () => {
  it("infers Eastern Time for Pennsylvania", () => {
    expect(inferTripTimeZone("PA", "America/Chicago")).toBe("America/New_York");
  });

  it("round-trips a Philadelphia wall time across the UTC boundary", () => {
    const iso = zonedInputToIso("2026-10-06T08:00", "America/New_York");
    expect(iso).toBe("2026-10-06T12:00:00.000Z");
    expect(toZonedInput(iso, "America/New_York")).toBe("2026-10-06T08:00");
  });

  it("labels the displayed local time zone", () => {
    expect(
      formatTripDateTime("2026-10-06T12:00:00.000Z", "America/New_York"),
    ).toMatch(/8:00\s*AM EDT/);
  });
});
