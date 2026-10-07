import { describe, expect, it } from "vitest";
import type { MeetingArtifact } from "@workspace/api-client-react";
import { combineMeetingPhotoPages } from "./meeting-photo-pages";

function page(id: string, transcript: string): MeetingArtifact {
  return {
    id,
    kind: "handwritten_notes",
    objectPath: `/objects/uploads/${id}`,
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: 100,
    transcript,
    createdAt: "2026-10-07T00:00:00.000Z",
  };
}

describe("meeting photo pages", () => {
  it("combines ordered OCR into one editable artifact and retains every source image", () => {
    const result = combineMeetingPhotoPages([
      page("one", "First page"),
      page("two", "Second page"),
    ]);
    expect(result.fileName).toBe("Paper notes (2 pages)");
    expect(result.transcript).toBe("Page 1\nFirst page\n\nPage 2\nSecond page");
    expect(result.sourcePages?.map((source) => source.objectPath)).toEqual([
      "/objects/uploads/one",
      "/objects/uploads/two",
    ]);
  });

  it("does not create an empty artifact", () => {
    expect(() => combineMeetingPhotoPages([])).toThrow("Select at least one");
  });
});
