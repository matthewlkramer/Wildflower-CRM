import { describe, expect, it, vi } from "vitest";
import {
  classifyFunderFinding,
  researchPublicFunder,
} from "./funderPublicResearch";

describe("public funder evidence", () => {
  it("requires a supported open cycle before promoting an announcement to Grant Leads", () => {
    const base = {
      published: "2026-11-08",
      today: "2026-11-11",
      official: true,
    };
    const title = "Learning Grant Program applications are open";
    expect(
      classifyFunderFinding({
        ...base,
        title,
        evidence: "Apply by November 30, 2026.",
      }),
    ).toEqual({ category: "funding_opportunity", deadline: "2026-11-30" });
    expect(
      classifyFunderFinding({
        ...base,
        title,
        evidence: "Apply by 2026-11-01.",
      }).category,
    ).toBe("general_news");
    expect(
      classifyFunderFinding({
        ...base,
        title: "Foundation announces recipients",
        evidence: "Request for proposals applications are now closed.",
      }).category,
    ).toBe("general_news");
    expect(
      classifyFunderFinding({
        ...base,
        title: "Foundation names new executive director",
        evidence: "",
      }).category,
    ).toBe("leadership_staff");
  });

  it("follows the official newsroom and rejects namesakes and undated search hits", async () => {
    const article =
      "<title>Applications are open for the Learning Grant Program</title>" +
      '<meta property="article:published_time" content="2026-11-10T12:00:00Z">' +
      "<main>Applications are open for the Learning Grant Program. Apply by November 30, 2026.</main>";
    const rss =
      "<rss><channel><item><title>North Star Foundation announcement</title>" +
      "<link>https://other.example/news</link></item></channel></rss>";
    const sources = {
      searchNews: vi.fn(async () => []),
      fetchPage: vi.fn(async (value: string) => {
        const url = new URL(value);
        if (url.hostname === "www.bing.com") return { url, markup: rss };
        if (url.hostname === "other.example")
          return {
            url,
            markup: "<title>North Star Foundation anniversary</title>",
          };
        if (url.pathname === "/")
          return { url, markup: '<a href="/news">News</a>' };
        if (url.pathname === "/news")
          return {
            url,
            markup: '<a href="/news/grant-program">Grant program</a>',
          };
        if (url.pathname === "/news/grant-program")
          return { url, markup: article };
        throw new Error("Unexpected fetch");
      }),
    };
    const result = await researchPublicFunder(
      {
        searchName: "North Star Foundation",
        website: "https://foundation.example/",
      },
      "2026-11-04",
      "2026-11-11",
      sources,
    );
    expect(result.complete).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({
        official: true,
        deadline: "2026-11-30",
        category: "funding_opportunity",
        article: expect.objectContaining({
          url: "https://foundation.example/news/grant-program",
          publicationDate: "2026-11-10",
        }),
      }),
    ]);
  });
});
