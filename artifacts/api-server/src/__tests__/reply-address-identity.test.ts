import { describe, expect, it } from "vitest";
import { replySenderName } from "../lib/replyAddressIdentity";
describe("reply display-name evidence", () => {
  it("accepts a complete human name with normalized whitespace", () => {
    expect(replySenderName('"Sara   Allan" <sara@example.org>')).toBe("Sara Allan");
    expect(replySenderName("Sara Allan <sara@example.org>")).toBe("Sara Allan");
  });
  it("rejects bare addresses, one-word names and multiple senders", () => {
    expect(replySenderName("sara@example.org")).toBeNull();
    expect(replySenderName("Sara <sara@example.org>")).toBeNull();
    expect(replySenderName("Sara Allan <sara@example.org>, Other Person <other@example.org>")).toBeNull();
  });
});
