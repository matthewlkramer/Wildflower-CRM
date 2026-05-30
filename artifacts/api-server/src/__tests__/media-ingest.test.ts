import { describe, expect, it } from "vitest";
import {
  buildGdeltQuery,
  gdeltDateToISO,
  parseGdeltArticles,
} from "../lib/gdelt";
import { mergeEntityId, personDisplayName } from "../lib/mediaIngest";

describe("buildGdeltQuery", () => {
  it("phrase-quotes the name and restricts to English", () => {
    expect(buildGdeltQuery("Acme Foundation")).toBe(
      '"Acme Foundation" sourcelang:english',
    );
  });

  it("strips embedded quotes so the query can't be malformed", () => {
    expect(buildGdeltQuery('The "Big" Fund')).toBe(
      '"The Big Fund" sourcelang:english',
    );
  });

  it("trims surrounding whitespace", () => {
    expect(buildGdeltQuery("  Jane Doe  ")).toBe(
      '"Jane Doe" sourcelang:english',
    );
  });
});

describe("gdeltDateToISO", () => {
  it("converts a YYYYMMDDThhmmssZ seendate to an ISO date", () => {
    expect(gdeltDateToISO("20260530T120000Z")).toBe("2026-05-30");
  });

  it("accepts a bare YYYYMMDD prefix", () => {
    expect(gdeltDateToISO("20240101")).toBe("2024-01-01");
  });

  it("rejects garbage / wrong types / impossible months", () => {
    expect(gdeltDateToISO("not-a-date")).toBeNull();
    expect(gdeltDateToISO(20260530 as unknown)).toBeNull();
    expect(gdeltDateToISO("20261330T000000Z")).toBeNull();
    expect(gdeltDateToISO(null)).toBeNull();
    expect(gdeltDateToISO(undefined)).toBeNull();
  });
});

describe("parseGdeltArticles", () => {
  it("parses a JSON string payload and drops articles without an http url", () => {
    const raw = JSON.stringify({
      articles: [
        {
          url: "https://example.com/a",
          title: "Headline A",
          domain: "example.com",
          seendate: "20260530T120000Z",
          language: "English",
        },
        { url: "ftp://nope.com/x", title: "bad scheme" },
        { url: "", title: "empty" },
        { title: "no url at all" },
      ],
    });
    const out = parseGdeltArticles(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      url: "https://example.com/a",
      title: "Headline A",
      domain: "example.com",
      publicationDate: "2026-05-30",
      language: "English",
    });
  });

  it("accepts an already-parsed object", () => {
    const out = parseGdeltArticles({
      articles: [{ url: "http://x.com/1", title: "T", domain: "x.com" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.publicationDate).toBeNull();
  });

  it("returns [] for non-JSON / empty / non-object / missing articles", () => {
    expect(parseGdeltArticles("<html>rate limited</html>")).toEqual([]);
    expect(parseGdeltArticles("")).toEqual([]);
    expect(parseGdeltArticles("{ not valid json")).toEqual([]);
    expect(parseGdeltArticles(null)).toEqual([]);
    expect(parseGdeltArticles(42)).toEqual([]);
    expect(parseGdeltArticles({ articles: "nope" })).toEqual([]);
  });
});

describe("personDisplayName", () => {
  it("prefers fullName", () => {
    expect(
      personDisplayName({ fullName: "Jane Q. Public", firstName: "Jane", lastName: "Public" }),
    ).toBe("Jane Q. Public");
  });

  it("falls back to first + last", () => {
    expect(personDisplayName({ firstName: "Jane", lastName: "Public" })).toBe(
      "Jane Public",
    );
  });

  it("returns null when only one usable token exists (too noisy to search)", () => {
    expect(personDisplayName({ firstName: "Jane" })).toBeNull();
    expect(personDisplayName({ lastName: "Public" })).toBeNull();
    expect(personDisplayName({ fullName: "   " })).toBeNull();
    expect(personDisplayName({})).toBeNull();
  });
});

describe("mergeEntityId", () => {
  it("appends a missing id", () => {
    expect(mergeEntityId(["a"], "b")).toEqual(["a", "b"]);
    expect(mergeEntityId(null, "b")).toEqual(["b"]);
    expect(mergeEntityId(undefined, "b")).toEqual(["b"]);
  });

  it("returns null when the id is already present (no-op)", () => {
    expect(mergeEntityId(["a", "b"], "b")).toBeNull();
  });
});
