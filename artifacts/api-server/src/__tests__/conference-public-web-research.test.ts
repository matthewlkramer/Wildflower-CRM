import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConferenceResearchError,
  researchConferencePublicWeb,
} from "../lib/conferencePublicWebResearch";

const eventUrl = "https://events.example.org/annual-program";

function providerResponse(
  jsonText: string,
  options: { citedUrl?: string; status?: number; error?: unknown } = {},
): Response {
  const citedUrl = options.citedUrl ?? eventUrl;
  return new Response(
    JSON.stringify(
      options.error ?? {
        output: [
          {
            type: "web_search_call",
            action: {
              status: "completed",
              sources: [{ url: eventUrl, title: "Official annual program" }],
            },
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: jsonText,
                annotations: [
                  {
                    type: "url_citation",
                    url: citedUrl,
                    title: "Official annual program",
                    start_index: 0,
                    end_index: 1,
                  },
                ],
              },
            ],
          },
        ],
      },
    ),
    {
      status: options.status ?? 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

describe("conference public-web research provider", () => {
  beforeEach(() => {
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "test-provider-key");
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails visibly without a configured provider and does not fetch", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchMock = vi.fn();
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({
      code: "provider_not_configured",
      retryable: true,
      message: expect.stringContaining("not configured"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to safely fetched public pages when the provider rejects web_search", async () => {
    const programHtml = [
      "<html><head><title>Annual Summit Program</title></head><body>",
       "<p>Avery Rivera, Research Director at Example Institute, will present the Opening keynote. Contact avery@example.org.</p>",
      "</body></html>",
    ].join("");
    const extraction = {
      output_text: JSON.stringify({
        results: [
          {
            name: "Avery Rivera",
            title: "Research Director",
            organization: "Example Institute",
            bio: null,
            profileUrl: null,
            session: "Opening keynote",
             email: "avery@example.org",
            sourceUrl: eventUrl,
            confidence: 0.94,
             evidence: "Avery Rivera, Research Director at Example Institute, will present the Opening keynote. Contact avery@example.org.",
            citationUrls: [eventUrl],
          },
        ],
      }),
    };
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        if (fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl).endsWith("/responses")).length === 1) {
          return providerResponse("", {
            status: 400,
            error: { error: { message: "web_search tool is not supported" } },
          });
        }
        return new Response(JSON.stringify(extraction), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("https://www.bing.com/search?")) {
        return new Response(
          `<rss><channel><item><title>Annual Summit Program</title><link>${eventUrl}</link></item></channel></rss>`,
          { status: 200, headers: { "Content-Type": "application/rss+xml" } },
        );
      }
      if (url === eventUrl) {
        return new Response(programHtml, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const result = await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      fetch: fetchMock as typeof fetch,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    });

    expect(result.results[0]).toMatchObject({
      kind: "agenda_speakers",
      name: "Avery Rivera",
      verifiedPublicEmail: true,
      sourceUrl: eventUrl,
    });
    expect(result.citations).toEqual([
      { url: eventUrl, title: "Annual Summit Program", accessedAt: result.researchedAt },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const extractionRequest = fetchMock.mock.calls[3][1] as RequestInit;
    const extractionBody = JSON.parse(String(extractionRequest.body));
    expect(extractionBody.tools).toBeUndefined();
    expect(extractionBody.input).toContain("Avery Rivera, Research Director");
  });

  it("uses fetched source text after malformed web-search citations and rejects invented dates", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        const calls = fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl).endsWith("/responses")).length;
        if (calls === 1) {
          return providerResponse(
            JSON.stringify({ results: [] }),
            { citedUrl: "https://unverified.example.net/page" },
          );
        }
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              results: [
                {
                  startDate: "2027-05-15",
                  endDate: null,
                  sourceUrl: eventUrl,
                  confidence: 0.8,
                  evidence: "The Summit takes place May 14, 2027.",
                  citationUrls: [eventUrl],
                },
              ],
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://www.bing.com/search?")) {
        return new Response(`<rss><item><title>Program</title><link>${eventUrl}</link></item></rss>`, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml" },
        });
      }
      if (url === eventUrl) {
        return new Response("<html><p>The Summit takes place May 14, 2027.</p></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        fetch: fetchMock as typeof fetch,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toMatchObject({
      code: "invalid_provider_response",
      retryable: false,
    });
  });

  it("refuses private or localhost official URLs before making public-page requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      providerResponse("", {
        status: 400,
        error: { error: { message: "web_search tool is not supported" } },
      }),
    );
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        officialUrl: "http://127.0.0.1/admin",
        fetch: fetchMock,
        resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    ).rejects.toMatchObject({
      code: "provider_request_failed",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not follow a public-source redirect to a private address", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/responses")) {
        return providerResponse("", {
          status: 400,
          error: { error: { message: "web_search tool is not supported" } },
        });
      }
      if (url.startsWith("https://www.bing.com/search?")) {
        return new Response(`<rss><item><title>Official</title><link>${eventUrl}</link></item></rss>`, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml" },
        });
      }
      if (url === eventUrl) {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/private" },
        });
      }
      throw new Error(`Unsafe redirect was fetched: ${url}`);
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        officialUrl: eventUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "provider_request_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "http://127.0.0.1/private",
    );
  });

  it("returns bounded speaker evidence and actual web-search citations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      providerResponse(
        JSON.stringify({
          results: [
            {
              name: "Avery Rivera",
              title: "Research Director",
              organization: "Example Institute",
              bio: "Leads public research programs.",
              profileUrl: "https://events.example.org/speakers/avery-rivera",
              session: "Opening keynote",
              email: "avery@example.org",
              sourceUrl: eventUrl,
              confidence: 0.96,
              evidence: "Avery Rivera, Research Director at Example Institute, will deliver the opening keynote.",
              citationUrls: [eventUrl],
            },
          ],
        }),
      ),
    );
    const result = await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      officialUrl: eventUrl,
      fetch: fetchMock,
    });

    expect(result.kind).toBe("agenda_speakers");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      kind: "agenda_speakers",
      name: "Avery Rivera",
      verifiedPublicEmail: false,
      title: "Research Director",
      organization: "Example Institute",
      session: "Opening keynote",
      sourceUrl: eventUrl,
      evidence: expect.stringContaining("opening keynote"),
    });
    expect(result.results[0].citations).toEqual([
      {
        url: eventUrl,
        title: "Official annual program",
        accessedAt: result.researchedAt,
      },
    ]);
    expect(result.citations).toHaveLength(1);

    const [requestUrl, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-provider-key",
    });
    const requestBody = JSON.parse(String(request.body));
    expect(requestBody.tools).toEqual([{ type: "web_search" }]);
    expect(requestBody.input).toContain("public web pages only");
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed structured output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse("not json"));
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        fetch: fetchMock,
      }),
    ).rejects.toBeInstanceOf(ConferenceResearchError);
  });
});