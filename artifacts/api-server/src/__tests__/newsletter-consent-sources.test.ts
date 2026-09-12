import { describe, expect, it } from "vitest";
import {
  filloutConsentEvidence,
  flodeskConsentEvidence,
  FILLOUT_COMMUNICATIONS_QUESTION,
} from "../lib/newsletterConsentSources";

const source = (answer: unknown = "Yes") => ({
  id: "rec_fixture",
  fields: {
    Email: "person@example.org",
    "Receive Communications": answer,
    "Entry Date": "2024-01-02T12:00:00Z",
    "Fillout Submission ID": "submission_fixture",
    "Raw Fillout Source Snapshot": JSON.stringify({
      fields: {
        "Thanks,  . And, what's your Email?": "person@example.org",
        [FILLOUT_COMMUNICATIONS_QUESTION]: "Yes",
        "Entry Date": "2024-01-02T12:00:00Z",
      },
    }),
  },
});
describe("newsletter source evidence", () => {
  it("preserves the actual source date and stable submission identity", () => {
    expect(filloutConsentEvidence(source(), true)).toMatchObject({
      eventType: "consent_given",
      sourceKey: "fillout:submission_fixture",
      occurredAt: new Date("2024-01-02T12:00:00Z"),
    });
  });
  it.each([undefined, "", "Maybe", "No"])(
    "does not turn missing, ambiguous, or conflicting answers into consent (%s)",
    (answer) => {
      const record = source();
      record.fields["Receive Communications"] = answer;
      expect(filloutConsentEvidence(record, true)).toBeNull();
    },
  );
  it("excludes test and disputed submissions", () => {
    const record = source();
    Object.assign(record.fields, { "Record Disposition": { name: "Test" } });
    expect(filloutConsentEvidence(record, true)).toBeNull();
  });
  it("does not guess identity from a changed or multi-address email", () => {
    const record = source();
    record.fields.Email = "someoneelse@example.org";
    expect(filloutConsentEvidence(record, true)).toBeNull();
  });
  it("preserves unknown dates without substituting a record-update or import date", () => {
    const record = source();
    record.fields["Raw Fillout Source Snapshot"] = JSON.stringify({
      fields: {
        "Thanks,  . And, what's your Email?": "person@example.org",
        [FILLOUT_COMMUNICATIONS_QUESTION]: "Yes",
        "Last updated": "2025-01-01T12:00:00Z",
      },
    });
    expect(filloutConsentEvidence(record, true)).toMatchObject({
      eventType: "consent_given",
      occurredAt: null,
    });
  });
  it("supports preserved legacy form evidence and an explicit decline", () => {
    const record = {
      id: "legacy",
      fields: {
        Email: "person@example.org",
        "Receive Communications": "No",
        "Entry Date": "2020-01-01T12:00:00Z",
        "JSONB of Start a School Form": JSON.stringify({
          Email: "person@example.org",
          "Receive Communications": "No",
        }),
      },
    };
    expect(filloutConsentEvidence(record, true)).toMatchObject({
      eventType: "opted_out",
      sourceKey: "ssj-airtable:legacy",
    });
  });
  it("does not equate Flodesk membership with affirmative consent", () => {
    const events = flodeskConsentEvidence({
      email: "person@example.org",
      status: "active",
      firstName: null,
      lastName: null,
      segments: [],
    });
    expect(events.map((e) => e.eventType)).toEqual(["legacy_selected"]);
  });
  it("retains consent and subsequent unsubscribe evidence separately", () => {
    const events = flodeskConsentEvidence({
      email: "person@example.org",
      status: "unsubscribed",
      optinTimestamp: "2020-01-01T12:00:00Z",
      firstName: null,
      lastName: null,
      segments: [],
    });
    expect(events.map((e) => e.eventType)).toEqual([
      "consent_given",
      "opted_out",
    ]);
    expect(events[1].occurredAt).toBeNull();
  });
});
