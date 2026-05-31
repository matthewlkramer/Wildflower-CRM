import { describe, expect, it } from "vitest";
import {
  defaultFiltersState,
  isDefaultFiltersState,
  resolveFilters,
  type FilterDef,
  type FiltersState,
} from "./filters";

function def(
  key: string,
  opts: Partial<Pick<FilterDef, "defaultVisible" | "required">> = {},
): FilterDef {
  return {
    key,
    label: key,
    render: () => null,
    ...opts,
  };
}

// Registry shape mirrors the list pages: a required search box, a couple
// of always-on enum filters, and opt-in presence filters (defaultVisible:false).
const registry: FilterDef[] = [
  def("search", { required: true }),
  def("type"),
  def("owner"),
  def("entities", { defaultVisible: false }),
  def("usages", { defaultVisible: false }),
];

describe("resolveFilters", () => {
  it("with no saved state, shows required + defaultVisible filters, hides opt-ins", () => {
    const keys = resolveFilters(registry, null).map((f) => f.key);
    expect(keys).toEqual(["search", "type", "owner"]);
  });

  it("treats undefined state the same as null", () => {
    const keys = resolveFilters(registry, undefined).map((f) => f.key);
    expect(keys).toEqual(["search", "type", "owner"]);
  });

  it("respects explicitly hidden keys", () => {
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities", "usages"],
      hidden: ["type"],
    };
    const keys = resolveFilters(registry, state).map((f) => f.key);
    expect(keys).toEqual(["search", "owner", "entities", "usages"]);
  });

  it("shows an opt-in filter the user has explicitly enabled (known, not hidden)", () => {
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities", "usages"],
      hidden: [],
    };
    const keys = resolveFilters(registry, state).map((f) => f.key);
    expect(keys).toEqual(["search", "type", "owner", "entities", "usages"]);
  });

  it("never hides required filters even if listed in hidden", () => {
    const state: FiltersState = {
      known: ["search", "type", "owner"],
      hidden: ["search", "type"],
    };
    const keys = resolveFilters(registry, state).map((f) => f.key);
    expect(keys).toContain("search");
    expect(keys).not.toContain("type");
  });

  it("a filter the saved state predates follows its registry default", () => {
    // Saved view from before `usages` existed: known omits it.
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities"],
      hidden: [],
    };
    const keys = resolveFilters(registry, state).map((f) => f.key);
    // entities is known+visible; usages is new opt-in → stays hidden.
    expect(keys).toEqual(["search", "type", "owner", "entities"]);
  });

  it("a new always-on filter the saved state predates becomes visible", () => {
    const extended = [...registry, def("fiscalYear")];
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities", "usages"],
      hidden: [],
    };
    const keys = resolveFilters(extended, state).map((f) => f.key);
    expect(keys).toContain("fiscalYear");
  });

  it("preserves registry order in output", () => {
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities", "usages"],
      hidden: [],
    };
    const keys = resolveFilters(registry, state).map((f) => f.key);
    expect(keys).toEqual(["search", "type", "owner", "entities", "usages"]);
  });
});

describe("defaultFiltersState", () => {
  it("lists every registry key in known and the opt-ins in hidden", () => {
    const state = defaultFiltersState(registry);
    expect(state.known).toEqual([
      "search",
      "type",
      "owner",
      "entities",
      "usages",
    ]);
    expect([...state.hidden].sort()).toEqual(["entities", "usages"]);
  });

  it("never lists required filters as hidden", () => {
    const reg = [def("search", { required: true, defaultVisible: false })];
    const state = defaultFiltersState(reg);
    expect(state.hidden).not.toContain("search");
  });

  it("resolves to the same visible set as null state", () => {
    const fromNull = resolveFilters(registry, null).map((f) => f.key);
    const fromDefault = resolveFilters(
      registry,
      defaultFiltersState(registry),
    ).map((f) => f.key);
    expect(fromDefault).toEqual(fromNull);
  });
});

describe("isDefaultFiltersState", () => {
  it("treats null/undefined as default", () => {
    expect(isDefaultFiltersState(registry, null)).toBe(true);
    expect(isDefaultFiltersState(registry, undefined)).toBe(true);
  });

  it("treats the canonical default state as default", () => {
    expect(
      isDefaultFiltersState(registry, defaultFiltersState(registry)),
    ).toBe(true);
  });

  it("is order-insensitive across known/hidden", () => {
    const state: FiltersState = {
      known: ["usages", "owner", "search", "entities", "type"],
      hidden: ["usages", "entities"],
    };
    expect(isDefaultFiltersState(registry, state)).toBe(true);
  });

  it("returns false when the user hid a default-visible filter", () => {
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities", "usages"],
      hidden: ["type", "entities", "usages"],
    };
    expect(isDefaultFiltersState(registry, state)).toBe(false);
  });

  it("returns false when the user revealed an opt-in filter", () => {
    const state: FiltersState = {
      known: ["search", "type", "owner", "entities", "usages"],
      hidden: ["entities"],
    };
    expect(isDefaultFiltersState(registry, state)).toBe(false);
  });
});
