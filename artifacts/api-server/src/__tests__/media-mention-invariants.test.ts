import { describe, it, expect } from "vitest";
import {
  validateMediaMentionInvariants,
  isHttpUrl,
  MEDIA_AI_SUMMARY_MAX_WORDS,
  MEDIA_AI_SUMMARY_MESSAGE,
  MEDIA_URL_MESSAGE,
} from "@workspace/api-zod";

describe("media mention field invariants", () => {
  const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

  describe("aiSummary word limit", () => {
    it(`accepts exactly ${MEDIA_AI_SUMMARY_MAX_WORDS} words`, () => {
      const issues = validateMediaMentionInvariants({
        aiSummary: words(MEDIA_AI_SUMMARY_MAX_WORDS),
      });
      expect(issues).toHaveLength(0);
    });

    it(`rejects ${MEDIA_AI_SUMMARY_MAX_WORDS + 1} words`, () => {
      const issues = validateMediaMentionInvariants({
        aiSummary: words(MEDIA_AI_SUMMARY_MAX_WORDS + 1),
      });
      expect(issues).toHaveLength(1);
      expect(issues[0]?.path).toBe("aiSummary");
      expect(issues[0]?.message).toBe(MEDIA_AI_SUMMARY_MESSAGE);
    });

    it("treats null/undefined/empty summary as valid", () => {
      expect(validateMediaMentionInvariants({ aiSummary: null })).toHaveLength(0);
      expect(validateMediaMentionInvariants({})).toHaveLength(0);
      expect(validateMediaMentionInvariants({ aiSummary: "   " })).toHaveLength(0);
    });

    it("collapses irregular whitespace when counting words", () => {
      const issues = validateMediaMentionInvariants({
        aiSummary: "  one\t two \n three  ",
      });
      expect(issues).toHaveLength(0);
    });
  });

  describe("url scheme guard", () => {
    const valid = ["http://example.com", "https://example.com/path?x=1"];
    const invalid = [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "mailto:a@b.com",
      "ftp://example.com",
      "example.com",
      "  javascript:alert(1)",
    ];

    for (const u of valid) {
      it(`accepts ${JSON.stringify(u)}`, () => {
        expect(isHttpUrl(u)).toBe(true);
        expect(validateMediaMentionInvariants({ url: u })).toHaveLength(0);
      });
    }

    for (const u of invalid) {
      it(`rejects ${JSON.stringify(u)}`, () => {
        expect(isHttpUrl(u)).toBe(false);
        const issues = validateMediaMentionInvariants({ url: u });
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe("url");
        expect(issues[0]?.message).toBe(MEDIA_URL_MESSAGE);
      });
    }

    it("treats null/empty url as valid (presence enforced by schema)", () => {
      expect(validateMediaMentionInvariants({ url: null })).toHaveLength(0);
      expect(validateMediaMentionInvariants({ url: "" })).toHaveLength(0);
    });
  });

  it("reports both summary and url issues together", () => {
    const issues = validateMediaMentionInvariants({
      aiSummary: words(MEDIA_AI_SUMMARY_MAX_WORDS + 5),
      url: "javascript:alert(1)",
    });
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path).sort()).toEqual(["aiSummary", "url"]);
  });
});
