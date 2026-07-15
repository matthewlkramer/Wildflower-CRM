import { describe, expect, it } from "vitest";
import { groupGiving } from "./giving-groups";

const opp = (id: string, status: string | null) => ({ id, status });
const gift = (
  id: string,
  opportunityId: string | null = null,
  dateReceived: string | null = null,
) => ({ id, opportunityId, dateReceived });

describe("groupGiving", () => {
  it("routes opportunities into sections by status", () => {
    const g = groupGiving(
      [
        opp("o1", "open"),
        opp("o2", "pledge"),
        opp("o3", "cash_in"),
        opp("o4", "dormant"),
        opp("o5", "lost"),
      ],
      [],
    );
    expect(g.openAsks.map((t) => t.opp.id)).toEqual(["o1"]);
    expect(g.waitingForPayment.map((t) => t.opp.id)).toEqual(["o2"]);
    expect(g.pastGiving.map((e) => e.opp?.id)).toEqual(["o3"]);
    expect(g.dormantOrLost.map((t) => t.opp.id)).toEqual(["o4", "o5"]);
  });

  it("never drops an opportunity with an unknown or missing status", () => {
    const g = groupGiving([opp("o1", "???"), opp("o2", null)], []);
    expect(g.pastGiving.map((e) => e.opp?.id)).toEqual(["o1", "o2"]);
  });

  it("nests gifts under their source opportunity wherever it lives", () => {
    const g = groupGiving(
      [opp("o1", "pledge"), opp("o2", "cash_in")],
      [gift("g1", "o1"), gift("g2", "o2"), gift("g3", "o2")],
    );
    expect(g.waitingForPayment[0].gifts.map((x) => x.id)).toEqual(["g1"]);
    expect(g.pastGiving[0].gifts.map((x) => x.id)).toEqual(["g2", "g3"]);
  });

  it("keeps gifts standalone when their opportunity is not in the fetched set", () => {
    const g = groupGiving([], [gift("g1", "missing-opp"), gift("g2")]);
    expect(g.pastGiving).toHaveLength(2);
    expect(g.pastGiving.every((e) => e.opp === null)).toBe(true);
    expect(g.pastGiving.flatMap((e) => e.gifts.map((x) => x.id))).toEqual([
      "g1",
      "g2",
    ]);
  });

  it("every gift appears exactly once across all sections", () => {
    const gifts = [
      gift("g1", "o1", "2026-01-01"),
      gift("g2", "gone", "2026-02-01"),
      gift("g3", null, "2026-03-01"),
      gift("g4", "o2", "2026-04-01"),
    ];
    const g = groupGiving([opp("o1", "open"), opp("o2", "lost")], gifts);
    const seen = [
      ...g.openAsks,
      ...g.waitingForPayment,
      ...g.dormantOrLost,
      ...g.pastGiving,
    ].flatMap((e) => e.gifts.map((x) => x.id));
    expect([...seen].sort()).toEqual(["g1", "g2", "g3", "g4"]);
    expect(seen).toHaveLength(4);
  });

  it("sorts past giving newest-first with undated entries last", () => {
    const g = groupGiving(
      [opp("o1", "cash_in"), opp("o2", "cash_in")],
      [
        gift("g1", "o1", "2025-06-01"),
        gift("g2", "o2", "2026-01-15"),
        gift("g3", null, "2025-12-31"),
        gift("g4", null, null),
      ],
    );
    expect(
      g.pastGiving.map((e) => e.opp?.id ?? e.gifts[0]?.id),
    ).toEqual(["o2", "g3", "o1", "g4"]);
  });

  it("uses the newest child gift as a thread's sort date", () => {
    const g = groupGiving(
      [opp("o1", "cash_in")],
      [
        gift("g1", "o1", "2024-01-01"),
        gift("g2", "o1", "2026-06-01"),
        gift("g3", null, "2025-01-01"),
      ],
    );
    expect(g.pastGiving.map((e) => e.opp?.id ?? e.gifts[0]?.id)).toEqual([
      "o1",
      "g3",
    ]);
  });
});
