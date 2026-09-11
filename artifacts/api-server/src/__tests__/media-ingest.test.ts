import { describe, expect, it } from "vitest";
import {
  buildGdeltQuery,
  gdeltDateToISO,
  parseGdeltArticles,
} from "../lib/gdelt";
import {
  foundationSearchName,
  isArticleRelevantToTarget,
  mergeEntityId,
  personDisplayName,
} from "../lib/mediaIngest";
import {
  canonicalizeMediaArticleUrl,
  canonicalizeMediaUrl,
  isMediaMentionFiltered,
  mediaDisqualifyingTerms,
  mediaHeadlineFingerprint,
  mediaRelevanceThreshold,
  normalizeMediaHeadline,
  scoreMediaRelevance,
} from "../lib/mediaRelevance";

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

  it("adds fundraising context to ambiguous person-name searches", () => {
    expect(buildGdeltQuery("Scott Cook", "person")).toBe(
      '"Scott Cook" (philanthropy OR philanthropic OR foundation OR nonprofit OR charity OR donation OR grant) sourcelang:english',
    );
  });
});

describe("media ingest precision", () => {
  it("canonicalizes tracking URL variants", () => {
    expect(
      canonicalizeMediaUrl(
        "https://www.Example.com/story/?utm_source=email&b=2&a=1#top",
      ),
    ).toBe("https://example.com/story?a=1&b=2");
  });

  it("uses an original publisher URL exposed by a syndication wrapper", () => {
    expect(
      canonicalizeMediaArticleUrl({
        url: "https://news.yahoo.com/acme-story?utm_source=feed",
        title: "Acme story",
        body: '<link rel="canonical" href="https://localpaper.org/acme-story?fbclid=123">',
      }),
    ).toBe("https://localpaper.org/acme-story");
  });

  it("fingerprints equivalent headline punctuation", () => {
    expect(normalizeMediaHeadline("A Grant — Announced!")).toBe(
      "agrantannounced",
    );
    expect(mediaHeadlineFingerprint("A Grant — Announced!")).toBe(
      mediaHeadlineFingerprint("A grant announced"),
    );
  });

  it("classifies person hits using name, affiliation, and location context", () => {
    const person = { kind: "person", id: "p1", name: "Scott Cook" } as const;
    expect(
      isArticleRelevantToTarget(person, {
        title: "Scott Cook announces a new philanthropic fund",
      }),
    ).toBe(true);
    expect(
      isArticleRelevantToTarget(person, {
        title: "Grenades and guns seized by police in southwest Sydney",
      }),
    ).toBe(false);
    expect(
      isArticleRelevantToTarget(person, {
        title: "Scott Cook charged after police investigation",
      }),
    ).toBe(false);
    expect(
      isArticleRelevantToTarget(person, {
        title: "Scott Cook joins a neighborhood committee",
      }),
    ).toBe(false);
    expect(
      isArticleRelevantToTarget(
        { kind: "organization", id: "o1", name: "Acme Foundation" },
        { title: "Regional giving roundup" },
      ),
    ).toBe(true);

    const contextual = {
      kind: "person" as const,
      id: "p2",
      name: "Jordan Lee",
      affiliations: ["Wildflower Schools"],
      locations: ["Minneapolis"],
    };
    expect(
      scoreMediaRelevance(contextual, {
        url: "https://example.org/story",
        title: "Wildflower Schools expands in Minneapolis",
      }),
    ).toBeGreaterThanOrEqual(0.4);
  });

  it("supports configurable thresholds and disqualifying terms", () => {
    expect(mediaRelevanceThreshold("0.65")).toBe(0.65);
    expect(mediaRelevanceThreshold("not-a-number")).toBe(0.4);
    expect(mediaDisqualifyingTerms("lawsuit, racing ")).toEqual([
      "lawsuit",
      "racing",
    ]);
    expect(isMediaMentionFiltered(0.39, false, 0.4)).toBe(true);
    expect(isMediaMentionFiltered(0.1, true, 0.4)).toBe(false);
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

  it("retains optional snippet and original publisher metadata", () => {
    const [article] = parseGdeltArticles({
      articles: [
        {
          url: "https://news.yahoo.com/story",
          title: "Story",
          domain: "news.yahoo.com",
          description: "Jordan Lee announced the grant.",
          originalurl: "https://publisher.org/story",
        },
      ],
    });
    expect(article).toMatchObject({
      snippet: "Jordan Lee announced the grant.",
      originalUrl: "https://publisher.org/story",
    });
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

describe("foundationSearchName", () => {
  it("takes the foundation segment from a 'Corp / Foundation' name", () => {
    expect(foundationSearchName("Wells Fargo / Wells Fargo Foundation")).toBe(
      "Wells Fargo Foundation",
    );
    expect(foundationSearchName("Amazon / Amazon Foundation")).toBe(
      "Amazon Foundation",
    );
    expect(foundationSearchName("J.P. Morgan Chase / JPM Foundation")).toBe(
      "JPM Foundation",
    );
  });

  it("qualifies a bare 'Foundation' segment with the corporation name", () => {
    expect(foundationSearchName("Old National Bank / Foundation")).toBe(
      "Old National Bank Foundation",
    );
    expect(foundationSearchName("City First Bank of DC / Foundation")).toBe(
      "City First Bank of DC Foundation",
    );
  });

  it("keeps philanthropic-arm markers like .org / Fundación", () => {
    expect(foundationSearchName("Google / Google.org")).toBe("Google.org");
    expect(foundationSearchName("Banco Popular / Fundación Banco Popular")).toBe(
      "Fundación Banco Popular",
    );
  });

  it("leaves names that already name a foundation untouched", () => {
    expect(foundationSearchName("3M Foundation")).toBe("3M Foundation");
    expect(foundationSearchName("Monsanto Fund")).toBe("Monsanto Fund");
    expect(foundationSearchName("Travelers Corporate Philanthropy")).toBe(
      "Travelers Corporate Philanthropy",
    );
  });

  it("appends 'Foundation' to a bare corporation name", () => {
    expect(foundationSearchName("Bank of America")).toBe(
      "Bank of America Foundation",
    );
    expect(foundationSearchName("Huntington National Bank")).toBe(
      "Huntington National Bank Foundation",
    );
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
