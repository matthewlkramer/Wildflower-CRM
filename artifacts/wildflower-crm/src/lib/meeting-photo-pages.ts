import type { MeetingArtifact } from "@workspace/api-client-react";

/** Keep all original images while presenting their OCR as one editable note. */
export function combineMeetingPhotoPages(
  pages: MeetingArtifact[],
): MeetingArtifact {
  if (!pages.length) throw new Error("Select at least one paper-note page.");
  if (pages.length > 24)
    throw new Error("Paper notes can have at most 24 pages.");
  if (pages.some((page) => page.kind !== "handwritten_notes")) {
    throw new Error("Only handwritten-note images can be combined.");
  }
  const first = pages[0];
  return {
    ...first,
    fileName:
      pages.length === 1
        ? first.fileName
        : `Paper notes (${pages.length} pages)`,
    transcript: pages
      .map((page, index) =>
        pages.length === 1
          ? page.transcript
          : `Page ${index + 1}\n${page.transcript}`,
      )
      .join("\n\n"),
    sourcePages: pages.map(({ objectPath, fileName, mimeType, sizeBytes }) => ({
      objectPath,
      fileName,
      mimeType,
      sizeBytes,
    })),
  };
}
