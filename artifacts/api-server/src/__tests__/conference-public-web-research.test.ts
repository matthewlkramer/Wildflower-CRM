import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConferenceResearchError,
  researchConferencePublicWeb,
} from "../lib/conferencePublicWebResearch";
import { extractConferencePdfText } from "../lib/conferencePdf";

const eventUrl = "https://events.example.org/annual-program";
const pdfUrl = "https://events.example.org/files/annual-program.pdf";
const speakerEvidence =
  "Avery Rivera, Research Director at Example Institute, will present the Opening keynote. Contact avery@example.org.";

function makePdf(objects: string[]): Buffer {
  let document = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
}

function makeTextPdf(text: string): Buffer {
  const escapePdfString = (value: string) =>
    value.replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/@/g, "\\100");
  const wrappedLines = text.split("\n").flatMap((line) => {
    const words = line.split(" ");
    const wrapped: string[] = [];
    let current = "";
    for (const word of words) {
      if (word.length > 80) {
        if (current) wrapped.push(current);
        current = "";
        for (let offset = 0; offset < word.length; offset += 80) {
          wrapped.push(word.slice(offset, offset + 80));
        }
      } else if (!current || current.length + word.length + 1 <= 80) {
        current = current ? `${current} ${word}` : word;
      } else {
        wrapped.push(current);
        current = word;
      }
    }
    if (current || wrapped.length === 0) wrapped.push(current);
    return wrapped;
  });
  const pageLines = Array.from(
    { length: Math.ceil(wrappedLines.length / 45) },
    (_, index) => wrappedLines.slice(index * 45, (index + 1) * 45),
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageLines.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pageLines.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of pageLines.entries()) {
    const pageObject = 4 + index * 2;
    const contentObject = pageObject + 1;
    const textCommands = lines.map((line, lineIndex) =>
      `${lineIndex === 0 ? "" : "T* "}(${escapePdfString(line)}) Tj`
    ).join("\n");
    const stream = `BT\n/F1 8 Tf\n12 TL\n72 750 Td\n${textCommands}\nET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    );
  }
  return makePdf(objects);
}

function makeImageOnlyPdf(): Buffer {
  const content = "q\n1 0 0 1 0 0 cm\n/Im0 Do\nQ";
  const contentStream =
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`;
  const imageStream = "FF0000>";
  const image =
    `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${imageStream.length} >>\nstream\n${imageStream}\nendstream`;
  return makePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
    contentStream,
    image,
  ]);
}

function pdfSpeakerExtraction(sourceUrl: string) {
  return {
    results: [
      {
        name: "Avery Rivera",
        title: "Research Director",
        organization: "Example Institute",
        bio: null,
        profileUrl: null,
        session: "Opening keynote",
        email: "avery@example.org",
        sourceUrl,
        confidence: 0.94,
        evidence: speakerEvidence,
        citationUrls: [sourceUrl],
      },
    ],
  };
}

function fallbackFetch(options: {
  searchUrls?: string[];
  searchTitles?: string[];
  pages: Record<string, Response>;
  extraction?: unknown;
}) {
  let providerCalls = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, _init) => {
    const url = String(input);
    if (url.endsWith("/responses")) {
      providerCalls += 1;
      if (providerCalls === 1) {
        return providerResponse("", {
          status: 400,
          error: { error: { message: "web_search tool is not supported" } },
        });
      }
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify(options.extraction ?? { results: [] }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://www.bing.com/search?")) {
      const items = (options.searchUrls ?? []).map((sourceUrl, index) =>
        `<item><title>${options.searchTitles?.[index] ?? "Annual Research Summit 2027 Official conference program PDF"}</title><link>${sourceUrl}</link></item>`
      ).join("");
      return new Response(`<rss><channel>${items}</channel></rss>`, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml" },
      });
    }
    if (url.startsWith("https://www.google.com/search?")) {
      return new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    const page = options.pages[url];
    if (page) return page;
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return fetchMock;
}

function publicResolver(hostname: string) {
  if (hostname === "www.bing.com" || hostname === "www.google.com") {
    return [{ address: "204.79.197.200", family: 4 }];
  }
  return [{ address: "93.184.216.34", family: 4 }];
}

function fallbackExtractionRequest(
  fetchMock: ReturnType<typeof fallbackFetch>,
): RequestInit | undefined {
  return fetchMock.mock.calls
    .map(([, request]) => request)
    .find((request) => {
      if (!request?.body) return false;
      const body = JSON.parse(String(request.body)) as { tools?: unknown };
      return body.tools === undefined;
    });
}

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

  it.each([
    { label: "an official PDF URL", officialUrl: pdfUrl, sourceUrl: pdfUrl },
    { label: "a PDF discovered in public search", sourceUrl: pdfUrl },
  ])("extracts cited speaker evidence from $label", async ({ officialUrl, sourceUrl }) => {
    const pdf = makeTextPdf(
      `${speakerEvidence}\nAnnual Research Summit takes place May 14, 2027.`,
    );
    const parsedText = await extractConferencePdfText(Uint8Array.from(pdf));
    expect(parsedText).toContain(speakerEvidence);
    expect(parsedText).toContain("May 14, 2027");
    const fetchMock = fallbackFetch({
      searchUrls: officialUrl ? [] : [sourceUrl],
      pages: {
        [sourceUrl]: new Response(Uint8Array.from(pdf), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
      extraction: pdfSpeakerExtraction(sourceUrl),
    });
    const result = await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      officialUrl,
      fetch: fetchMock as typeof fetch,
      resolveHost: async (hostname) => publicResolver(hostname),
    });

    expect(result.results[0]).toMatchObject({
      kind: "agenda_speakers",
      name: "Avery Rivera",
      email: "avery@example.org",
      verifiedPublicEmail: true,
      sourceUrl,
    });
    expect(result.results[0].evidence).toContain("Avery Rivera");
    expect(result.citations).toEqual([
      expect.objectContaining({ url: sourceUrl, accessedAt: result.researchedAt }),
    ]);
    const extractionRequest = fallbackExtractionRequest(fetchMock);
    expect(String(extractionRequest?.body)).toContain(sourceUrl);
    expect(String(extractionRequest?.body)).toContain("Avery Rivera");
    expect(String(extractionRequest?.body)).toContain("avery@example.org");
    expect(String(extractionRequest?.body)).toContain("May 14, 2027");
  });

  it("follows a PDF link found on the fetched official event page", async () => {
    const linkedPdf = "https://events.example.org/files/program-handout.pdf";
    const html = new Response(
      `<html><head><title>Annual Summit</title></head><body><a href="${linkedPdf}">Download the program</a></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
    const pdf = makeTextPdf(
      `${speakerEvidence}\nAnnual Research Summit takes place May 14, 2027.`,
    );
    const fetchMock = fallbackFetch({
      pages: {
        [eventUrl]: html,
        [linkedPdf]: new Response(Uint8Array.from(pdf), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
      extraction: pdfSpeakerExtraction(linkedPdf),
    });
    const result = await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      officialUrl: eventUrl,
      fetch: fetchMock as typeof fetch,
      resolveHost: async (hostname) => publicResolver(hostname),
    });

    expect(result.results[0]).toMatchObject({
      name: "Avery Rivera",
      email: "avery@example.org",
      sourceUrl: linkedPdf,
    });
    expect(result.citations.map((citation) => citation.url)).toContain(linkedPdf);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(linkedPdf);
  });

  it("processes an official linked PDF despite six or more other HTML search hits", async () => {
    const linkedPdf = "https://events.example.org/files/agenda-linked.pdf";
    const searchHits = Array.from(
      { length: 7 },
      (_, index) => `https://programs.example.net/events/annual-summit-${index + 1}.html`,
    );
    const pages: Record<string, Response> = {
      [eventUrl]: new Response(
        `<html><body><a href="${linkedPdf}">Download the official agenda PDF</a></body></html>`,
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
      [linkedPdf]: new Response(
        Uint8Array.from(makeTextPdf(speakerEvidence)),
        { status: 200, headers: { "Content-Type": "application/pdf" } },
      ),
    };
    for (const url of searchHits) {
      pages[url] = new Response("<html><body>Related event information.</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    const fetchMock = fallbackFetch({
      searchUrls: searchHits,
      searchTitles: searchHits.map(() => "Annual Research Summit 2027 program"),
      pages,
      extraction: pdfSpeakerExtraction(linkedPdf),
    });

    const result = await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      officialUrl: eventUrl,
      fetch: fetchMock as typeof fetch,
      resolveHost: async (hostname) => publicResolver(hostname),
    });

    expect(result.results[0]).toMatchObject({
      name: "Avery Rivera",
      email: "avery@example.org",
      sourceUrl: linkedPdf,
    });
    expect(result.citations.map(({ url }) => url)).toContain(linkedPdf);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(linkedPdf);
  });

  it("keeps a usable cited PDF finding when another discovered PDF is malformed", async () => {
    const malformedPdf = "https://events.example.org/files/malformed-program.pdf";
    const fetchMock = fallbackFetch({
      searchUrls: [malformedPdf, pdfUrl],
      pages: {
        [malformedPdf]: new Response(
          Uint8Array.from(Buffer.from("%PDF-1.4\nbroken xref and no page tree")),
          { status: 200, headers: { "Content-Type": "application/pdf" } },
        ),
        [pdfUrl]: new Response(
          Uint8Array.from(makeTextPdf(speakerEvidence)),
          { status: 200, headers: { "Content-Type": "application/pdf" } },
        ),
      },
      extraction: pdfSpeakerExtraction(pdfUrl),
    });

    const result = await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      fetch: fetchMock as typeof fetch,
      resolveHost: async (hostname) => publicResolver(hostname),
    });

    expect(result.results[0]).toMatchObject({
      name: "Avery Rivera",
      email: "avery@example.org",
      sourceUrl: pdfUrl,
    });
    expect(result.citations.map(({ url }) => url)).toContain(pdfUrl);
  });

  it("does not parse or cite a PDF reached by redirecting an HTTP official URL", async () => {
    const httpOfficialUrl = "http://events.example.org/annual-program";
    const redirectedPdf = "https://events.example.org/files/redirected-program.pdf";
    const fetchMock = fallbackFetch({
      pages: {
        [httpOfficialUrl]: new Response(null, {
          status: 302,
          headers: { Location: redirectedPdf },
        }),
        [redirectedPdf]: new Response(
          Uint8Array.from(makeTextPdf(speakerEvidence)),
          { status: 200, headers: { "Content-Type": "application/pdf" } },
        ),
      },
      extraction: pdfSpeakerExtraction(redirectedPdf),
    });

    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: httpOfficialUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toBeInstanceOf(ConferenceResearchError);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/responses")))
      .toHaveLength(1);
  });

  it("rejects a May 1 date when the PDF only supports May 14", async () => {
    const evidence = "The Annual Research Summit begins May 14, 2027.";
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(
          Uint8Array.from(makeTextPdf(evidence)),
          { status: 200, headers: { "Content-Type": "application/pdf" } },
        ),
      },
      extraction: {
        results: [
          {
            startDate: "2027-05-01",
            endDate: null,
            sourceUrl: pdfUrl,
            confidence: 0.9,
            evidence,
            citationUrls: [pdfUrl],
          },
        ],
      },
    });

    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response", retryable: false });
  });

  it.each([
    [
      "a PDF body served with an HTML content type",
      () => makeTextPdf(speakerEvidence),
      "text/html",
    ],
    [
      "non-PDF bytes served with a PDF content type",
      () => Buffer.from("<html>not a PDF file</html>"),
      "application/pdf",
    ],
  ])("does not pass through %s", async (_label, makeBody, contentType) => {
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(Uint8Array.from(makeBody()), {
          status: 200,
          headers: { "Content-Type": contentType },
        }),
      },
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({
      code: "unsupported_public_pdf",
      retryable: true,
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/responses")))
      .toHaveLength(1);
  });

  it("rejects an oversized PDF before requesting AI extraction", async () => {
    const tooLarge = Buffer.alloc(3_000_001, 0x20);
    Buffer.from("%PDF-1.4\n").copy(tooLarge);
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(Uint8Array.from(tooLarge), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "unsupported_public_pdf", retryable: true });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/responses")))
      .toHaveLength(1);
  });

  it("rejects PDFs above the page limit before requesting AI extraction", async () => {
    const moreThanTwentyFourPages = makeTextPdf(
      Array.from({ length: 45 * 25 }, (_, index) => `Research program line ${index + 1}`)
        .join("\n"),
    );
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(Uint8Array.from(moreThanTwentyFourPages), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
    });

    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "unsupported_public_pdf", retryable: true });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/responses")))
      .toHaveLength(1);
  });

  it("rejects an AI-invented email absent from parsed PDF evidence", async () => {
    const evidence = "Avery Rivera will present the Opening keynote.";
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(Uint8Array.from(makeTextPdf(evidence)), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
      extraction: {
        results: [
          {
            name: "Avery Rivera",
            title: null,
            organization: null,
            bio: null,
            profileUrl: null,
            session: "Opening keynote",
            email: "avery@invented.example",
            sourceUrl: pdfUrl,
            confidence: 0.9,
            evidence,
            citationUrls: [pdfUrl],
          },
        ],
      },
    });

    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "uncited_research", retryable: false });
  });

  it("rejects an AI-invented date that conflicts with parsed PDF evidence", async () => {
    const evidence = "The Annual Research Summit begins May 14, 2027.";
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(Uint8Array.from(makeTextPdf(evidence)), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
      extraction: {
        results: [
          {
            startDate: "2027-05-15",
            endDate: null,
            sourceUrl: pdfUrl,
            confidence: 0.9,
            evidence,
            citationUrls: [pdfUrl],
          },
        ],
      },
    });

    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "dates",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response", retryable: false });
  });

  it("blocks a public HTTPS PDF redirect to HTTP before fetching the target", async () => {
    const insecureTarget = "http://events.example.org/files/insecure-program.pdf";
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(null, {
          status: 302,
          headers: { Location: insecureTarget },
        }),
      },
    });

    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "unsupported_public_pdf", retryable: true });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(insecureTarget);
  });

  it.each([
    ["a scanned image-only PDF", () => makeImageOnlyPdf()],
    ["a malformed PDF", () => Buffer.from("%PDF-1.4\nthis is not a valid PDF document")],
  ])("treats %s as an unsupported source and remains retryable", async (_label, makeBody) => {
    const fetchMock = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(Uint8Array.from(makeBody()), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        }),
      },
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: fetchMock as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "unsupported_public_pdf", retryable: true });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/responses")))
      .toHaveLength(1);
  });

  it("does not fetch private PDF destinations or follow redirects to private hosts", async () => {
    const privatePdf = "https://private.example.org/program.pdf";
    const privateFetch = fallbackFetch({
      searchUrls: [privatePdf],
      pages: {},
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        fetch: privateFetch as typeof fetch,
        resolveHost: async (hostname) =>
          hostname === "private.example.org"
            ? [{ address: "10.0.0.8", family: 4 }]
            : publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "unsupported_public_pdf", retryable: true });
    expect(privateFetch.mock.calls.map(([input]) => String(input))).not.toContain(privatePdf);

    const redirectFetch = fallbackFetch({
      pages: {
        [pdfUrl]: new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1/internal.pdf" },
        }),
      },
    });
    await expect(
      researchConferencePublicWeb({
        conferenceName: "Annual Research Summit",
        year: 2027,
        kind: "agenda_speakers",
        officialUrl: pdfUrl,
        fetch: redirectFetch as typeof fetch,
        resolveHost: async (hostname) => publicResolver(hostname),
      }),
    ).rejects.toMatchObject({ code: "unsupported_public_pdf", retryable: true });
    expect(redirectFetch.mock.calls.map(([input]) => String(input)))
      .not.toContain("http://127.0.0.1/internal.pdf");
  });

  it("bounds the number of fetched PDF sources and the PDF text sent for extraction", async () => {
    const searchUrls = Array.from(
      { length: 8 },
      (_, index) => `https://events.example.org/files/program-${index + 1}.pdf`,
    );
    const longPdf = makeTextPdf(
      `${speakerEvidence}\n${"x".repeat(18_000)}\nEND_OF_UNBOUNDED_PDF_TEXT`,
    );
    const pages = Object.fromEntries(searchUrls.map((url, index) => [
      url,
      new Response(
        Uint8Array.from(index === 0 ? longPdf : makeTextPdf("Annual Summit public program.")),
        {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        },
      ),
    ]));
    const fetchMock = fallbackFetch({ searchUrls, pages });
    await researchConferencePublicWeb({
      conferenceName: "Annual Research Summit",
      year: 2027,
      kind: "agenda_speakers",
      fetch: fetchMock as typeof fetch,
      resolveHost: async (hostname) => publicResolver(hostname),
    });

    const fetchedPdfs = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/files/program-") && url.endsWith(".pdf"));
    expect(fetchedPdfs).toHaveLength(6);
    const extractionRequest = fallbackExtractionRequest(fetchMock);
    const extractionInput = String(extractionRequest?.body);
    expect(extractionInput).not.toContain("END_OF_UNBOUNDED_PDF_TEXT");
    expect(extractionInput.length).toBeLessThan(15_000);
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