import { describe, expect, it } from "vitest";
import { matchTranscriptAttendance, transcriptSpeakers } from "../lib/meetingAttendance";

describe("transcript attendance", () => {
  it("matches named Zoom and VTT speakers, including an abbreviated staff name", () => {
    const transcript = [
      "WEBVTT",
      "1\n00:00:13.000 --> 00:00:15.000\nJefferson Chang: Hi.",
      "2\n00:00:14.000 --> 00:00:16.000\n<v Matt Kramer - Wildflower Schools>Welcome.</v>",
      "3\n00:00:17.000 --> 00:00:19.000\nErica Cantoni (she/her) Wildflower Schools: Thanks.",
      "4\n00:00:20.000 --> 00:00:21.000\nKathy Hamel: Good morning.",
      "5\n00:00:21.000 --> 00:00:22.000\nGuest Speaker: Hello.",
      "6\n00:00:22.000 --> 00:00:24.000\nSpeaker 1: Please call Robin Green.",
      "Robin Green: from written notes only",
    ].join("\n\n");
    expect(matchTranscriptAttendance(transcriptSpeakers(transcript), [
      { email: "jchang@example.org" },
      { email: "matthew.kramer@example.org", names: ["Matthew Kramer"] },
      { email: "erica.cantoni@example.org" },
      { email: "khamel@example.org" },
      { email: "robin.green@example.org" },
    ])).toEqual([
      { name: "Jefferson Chang", email: "jchang@example.org" },
      { name: "Matt Kramer", email: "matthew.kramer@example.org" },
      { name: "Erica Cantoni", email: "erica.cantoni@example.org" },
      { name: "Kathy Hamel", email: "khamel@example.org" },
      { name: "Guest Speaker", email: null },
    ]);
  });

  it("leaves ambiguous addresses unmatched and does not count silent invitees", () => {
    expect(matchTranscriptAttendance(["Jan Lee"], [
      { email: "jlee@one.example" },
      { email: "jlee@two.example" },
      { email: "sarah.white@example.org" },
    ])).toEqual([{ name: "Jan Lee", email: null }]);
  });
});
