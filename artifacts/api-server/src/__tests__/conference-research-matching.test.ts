import { describe, expect, it } from "vitest";
import {
  matchSpeakerCandidates,
  normalizeIdentity,
} from "../lib/conferenceSpeakerMatching";
import {
  getDueConferenceResearchWindows,
  getResearchRetryDelayMs,
  isCredentialUnavailable,
  isResearchLeaseOwner,
  isScheduledWindowCurrent,
  makeConferenceResearchPrompt,
  researchPromptMatchesCurrentContext,
  scheduledWindowStartDate,
} from "../lib/conferenceResearchWorker";

describe("conference speaker identity matching", () => {
  it("normalizes names without erasing their full-name identity", () => {
    expect(normalizeIdentity("  José   O’Connor, Ph.D. ")).toBe("jose o connor ph d");
  });

  it("matches one exact public email even when names differ", () => {
    const result = matchSpeakerCandidates({
      name: "A. Different",
      email: "SPEAKER@example.org",
      candidates: [
        {
          personId: "person-1",
          name: "Speaker Person",
          email: "speaker@example.org",
          organizationId: null,
          organizationName: null,
          matchEvidence: null,
        },
      ],
    });
    expect(result.matchedPersonId).toBe("person-1");
    expect(result.evidence).toContain("exact email");
  });

  it("requires unique full name and corroborating current organization", () => {
    const candidate = {
      personId: "person-1",
      name: "Jordan Lee",
      email: null,
      organizationId: "org-1",
      organizationName: "North Star Institute",
      matchEvidence: null,
    };
    expect(matchSpeakerCandidates({
      name: "Jordan Lee",
      organizationName: "North Star Institute",
      candidates: [candidate],
    }).matchedPersonId).toBe("person-1");
    expect(matchSpeakerCandidates({
      name: "Jordan Lee",
      organizationName: "Other Institute",
      candidates: [candidate],
    }).matchedPersonId).toBeNull();
    expect(matchSpeakerCandidates({
      name: "Jordan Lee",
      candidates: [candidate],
    }).matchedPersonId).toBeNull();
  });

  it("retains ambiguous same-name people as review candidates", () => {
    const candidates = ["person-1", "person-2"].map((personId) => ({
      personId,
      name: "Alex Kim",
      email: null,
      organizationId: null,
      organizationName: null,
      matchEvidence: null,
    }));
    const result = matchSpeakerCandidates({
      name: "Alex Kim",
      candidates,
    });
    expect(result.matchedPersonId).toBeNull();
    expect(result.candidates.map((candidate) => candidate.personId)).toEqual(["person-1", "person-2"]);
  });
});

describe("conference research scheduler windows", () => {
  it("queues missing-date research and catches up both agenda windows", () => {
    expect(getDueConferenceResearchWindows({ startDate: null }, "2027-06-01")).toEqual([
      { kind: "dates", windowKey: "dates_missing" },
    ]);
    expect(getDueConferenceResearchWindows({ startDate: "2027-06-02" }, "2027-06-01")).toEqual([
      { kind: "agenda_speakers", windowKey: "before_21_days:2027-06-02" },
      { kind: "agenda_speakers", windowKey: "before_2_days:2027-06-02" },
    ]);
  });

  it("only enqueues the 21-day window when the event is in its 21-day lead window", () => {
    expect(getDueConferenceResearchWindows({ startDate: "2027-06-15" }, "2027-06-01")).toEqual([
      { kind: "agenda_speakers", windowKey: "before_21_days:2027-06-15" },
    ]);
    expect(getDueConferenceResearchWindows({ startDate: "2027-07-01" }, "2027-06-01")).toEqual([]);
  });

  it("invalidates scheduled agenda jobs when their keyed event date changes, but preserves explicit backfills", () => {
    expect(scheduledWindowStartDate("before_21_days:2027-06-15")).toBe("2027-06-15");
    expect(isScheduledWindowCurrent("agenda_speakers", "before_2_days:2027-06-15", "2027-06-15")).toBe(true);
    expect(isScheduledWindowCurrent("agenda_speakers", "before_2_days:2027-06-15", "2027-06-16")).toBe(false);
    expect(isScheduledWindowCurrent("agenda_speakers", "dates_confirmed:2027-06-15", "2027-06-16")).toBe(false);
    expect(isScheduledWindowCurrent("agenda_speakers", "retroactive", "2027-06-16")).toBe(true);
  });

  it("detects changed conference prompt context after a year or type reassignment", () => {
    const request = {
      prompt: makeConferenceResearchPrompt("Example Summit 2027", 2027, "agenda_speakers", null, null),
      kind: "agenda_speakers" as const,
      attendeeSiteUrl: null,
      instructions: null,
    };
    expect(researchPromptMatchesCurrentContext(request, { nameOverride: null, year: 2027 }, "Example Summit")).toBe(true);
    expect(researchPromptMatchesCurrentContext(request, { nameOverride: null, year: 2028 }, "Example Summit")).toBe(false);
    expect(researchPromptMatchesCurrentContext(request, { nameOverride: null, year: 2027 }, "Different Summit")).toBe(false);
  });
});

describe("conference research lease fencing and retries", () => {
  it("rejects a stale worker after the same request is reclaimed with a newer attempt", () => {
    const startedAt = new Date("2027-06-01T12:00:00.000Z");
    const oldLease = { id: "request-1", attempts: 1, startedAt };
    expect(isResearchLeaseOwner({ status: "running", attempts: 1, startedAt }, oldLease)).toBe(true);
    expect(isResearchLeaseOwner({
      status: "running",
      attempts: 2,
      startedAt: new Date("2027-06-01T12:10:01.000Z"),
    }, oldLease)).toBe(false);
    expect(isResearchLeaseOwner({ status: "queued", attempts: 1, startedAt }, oldLease)).toBe(false);
  });

  it("keeps missing or rejected credentials retryable with a bounded delayed retry", () => {
    expect(isCredentialUnavailable(Object.assign(new Error("not configured"), { code: "provider_not_configured" }))).toBe(true);
    expect(isCredentialUnavailable(new Error("Public conference research provider returned HTTP 401."))).toBe(true);
    expect(isCredentialUnavailable(new Error("Public conference research provider returned HTTP 500."))).toBe(false);
    expect(getResearchRetryDelayMs(1, true)).toBe(15 * 60_000);
    expect(getResearchRetryDelayMs(10_000, true)).toBe(24 * 60 * 60_000);
    expect(getResearchRetryDelayMs(10_000)).toBe(6 * 60 * 60_000);
  });
});