import { describe, it, expect } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getTableName, is } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import {
  unionArrays,
  computePrimaryUpdates,
  FUNDER_MERGE_CONFIG,
  PERSON_MERGE_CONFIG,
} from "../lib/mergeEntities";

/**
 * Derive, straight from the Drizzle schema, every foreign-key column that
 * references the given table's id. Used to guarantee the merge config's
 * hand-maintained FK inventory can never silently fall behind a schema
 * change (a missed FK would orphan rows or cascade-delete on merge).
 */
function derivedFkRefs(targetTableName: string): Set<string> {
  const refs = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    const tableName = getTableName(value);
    for (const fk of cfg.foreignKeys) {
      const ref = fk.reference();
      const foreignTable = getTableName(ref.foreignTable);
      if (foreignTable !== targetTableName) continue;
      const foreignCols = ref.foreignColumns.map((c) => c.name);
      // Only single-column FKs landing on the id column matter here.
      if (foreignCols.length === 1 && foreignCols[0] === "id") {
        for (const col of ref.columns) {
          refs.add(`${tableName}.${col.name}`);
        }
      }
    }
  }
  return refs;
}

describe("unionArrays", () => {
  it("dedupes preserving first-occurrence order", () => {
    expect(unionArrays(["a", "b"], ["b", "c"], ["a", "d"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("drops null/undefined/empty entries and arrays", () => {
    expect(unionArrays(["a", "", "b"], null, undefined, ["", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("returns empty for no input", () => {
    expect(unionArrays()).toEqual([]);
  });
});

describe("computePrimaryUpdates — funders", () => {
  it("applies only whitelisted scalar overrides", () => {
    const primary = { id: "f1", name: "Primary", regionIds: [] };
    const set = computePrimaryUpdates(
      FUNDER_MERGE_CONFIG,
      primary,
      [{ id: "f2", name: "Loser", regionIds: [] }],
      { name: "Chosen", id: "hacker", notAField: "x", priority: "high" },
    );
    expect(set.name).toBe("Chosen");
    expect(set.priority).toBe("high");
    expect(set.id).toBeUndefined();
    expect(set.notAField).toBeUndefined();
  });

  it("unions own array columns across primary + losers", () => {
    const primary = {
      id: "f1",
      name: "P",
      regionIds: ["r1"],
      interestsThematic: ["arts"],
      interestsAges: [],
      interestsGovModels: [],
      historicalNames: [],
    };
    const losers = [
      {
        id: "f2",
        name: "L1",
        regionIds: ["r2", "r1"],
        interestsThematic: ["stem"],
        interestsAges: ["k12"],
        interestsGovModels: [],
        historicalNames: [],
      },
    ];
    const set = computePrimaryUpdates(FUNDER_MERGE_CONFIG, primary, losers, {});
    expect(set.regionIds).toEqual(["r1", "r2"]);
    expect(set.interestsThematic).toEqual(["arts", "stem"]);
    expect(set.interestsAges).toEqual(["k12"]);
  });

  it("appends loser display names to historical_names, excluding the final name", () => {
    const primary = {
      id: "f1",
      name: "Acme Foundation",
      regionIds: [],
      interestsThematic: [],
      interestsAges: [],
      interestsGovModels: [],
      historicalNames: ["Old Acme"],
    };
    const losers = [
      {
        id: "f2",
        name: "Acme Fund",
        regionIds: [],
        interestsThematic: [],
        interestsAges: [],
        interestsGovModels: [],
        historicalNames: ["Legacy Co"],
      },
      {
        id: "f3",
        name: "Acme Foundation",
        regionIds: [],
        interestsThematic: [],
        interestsAges: [],
        interestsGovModels: [],
        historicalNames: [],
      },
    ];
    const set = computePrimaryUpdates(FUNDER_MERGE_CONFIG, primary, losers, {});
    // "Acme Foundation" (== final name) excluded; "Old Acme", "Legacy Co",
    // and "Acme Fund" retained in first-seen order.
    expect(set.historicalNames).toEqual(["Old Acme", "Legacy Co", "Acme Fund"]);
  });

  it("uses the overridden name when deciding what to exclude from historical_names", () => {
    const primary = {
      id: "f1",
      name: "Primary Name",
      regionIds: [],
      interestsThematic: [],
      interestsAges: [],
      interestsGovModels: [],
      historicalNames: [],
    };
    const losers = [
      {
        id: "f2",
        name: "Winner Name",
        regionIds: [],
        interestsThematic: [],
        interestsAges: [],
        interestsGovModels: [],
        historicalNames: [],
      },
    ];
    const set = computePrimaryUpdates(FUNDER_MERGE_CONFIG, primary, losers, {
      name: "Winner Name",
    });
    expect(set.name).toBe("Winner Name");
    // Loser name now equals the final name, so it is not added back.
    expect(set.historicalNames).toEqual([]);
  });
});

describe("computePrimaryUpdates — people", () => {
  it("has no historical_names handling and unions interest arrays", () => {
    const primary = {
      id: "p1",
      regionIds: ["r1"],
      interestsThematic: ["a"],
      interestsAges: [],
      interestsGovModels: [],
    };
    const set = computePrimaryUpdates(
      PERSON_MERGE_CONFIG,
      primary,
      [
        {
          id: "p2",
          regionIds: ["r2"],
          interestsThematic: ["b"],
          interestsAges: [],
          interestsGovModels: [],
        },
      ],
      { firstName: "Jane" },
    );
    expect(set.firstName).toBe("Jane");
    expect(set.regionIds).toEqual(["r1", "r2"]);
    expect(set.interestsThematic).toEqual(["a", "b"]);
    expect(set.historicalNames).toBeUndefined();
  });
});

describe("merge config inventory", () => {
  // These are the only FK references intentionally left out of the merge
  // engine, with the reason. Any OTHER schema FK to funders/people that is
  // missing from the config will fail the exact-match assertions below —
  // this is the guard that prevents a future FK from silently orphaning
  // rows or cascade-deleting data on merge.
  const EXPECTED_FK_OMISSIONS: Record<string, string[]> = {
    // (none today — both entities reassign every id-targeting FK)
    funders: [],
    people: [],
  };

  it("funder fkRefs exactly match every schema FK targeting funders.id", () => {
    const derived = derivedFkRefs("funders");
    for (const omit of EXPECTED_FK_OMISSIONS.funders) derived.delete(omit);
    const configured = new Set(
      FUNDER_MERGE_CONFIG.fkRefs.map((r) => `${r.table}.${r.col}`),
    );
    expect([...configured].sort()).toEqual([...derived].sort());
  });

  it("person fkRefs exactly match every schema FK targeting people.id", () => {
    const derived = derivedFkRefs("people");
    for (const omit of EXPECTED_FK_OMISSIONS.people) derived.delete(omit);
    const configured = new Set(
      PERSON_MERGE_CONFIG.fkRefs.map((r) => `${r.table}.${r.col}`),
    );
    expect([...configured].sort()).toEqual([...derived].sort());
  });

  it("funder arrayRefs cover the known text[] slug-array references", () => {
    const arr = FUNDER_MERGE_CONFIG.arrayRefs.map((r) => `${r.table}.${r.col}`);
    expect(arr.sort()).toEqual(
      [
        "calendar_events.matched_funder_ids",
        "email_messages.matched_funder_ids",
        "interactions.funder_ids",
        "media_mentions.funder_ids",
        "notes.funder_ids",
        "tasks.funder_ids",
        "tracked_emails.recipient_funder_ids",
      ].sort(),
    );
  });

  it("person arrayRefs cover the known text[] slug-array references", () => {
    const arr = PERSON_MERGE_CONFIG.arrayRefs.map((r) => `${r.table}.${r.col}`);
    expect(arr.sort()).toEqual(
      [
        "calendar_events.matched_person_ids",
        "email_messages.matched_person_ids",
        "interactions.person_ids",
        "media_mentions.person_ids",
        "notes.person_ids",
        "tasks.person_ids",
        "tracked_emails.recipient_person_ids",
      ].sort(),
    );
  });

  it("self-ref columns are configured and included in fkRefs", () => {
    expect(FUNDER_MERGE_CONFIG.selfRefCol).toBe("parent_funder_id");
    expect(PERSON_MERGE_CONFIG.selfRefCol).toBe("assistant_person_id");
    expect(
      FUNDER_MERGE_CONFIG.fkRefs.some(
        (r) => r.table === "funders" && r.col === "parent_funder_id",
      ),
    ).toBe(true);
    expect(
      PERSON_MERGE_CONFIG.fkRefs.some(
        (r) => r.table === "people" && r.col === "assistant_person_id",
      ),
    ).toBe(true);
  });
});
