import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadQuickbooksAttachment } from "../lib/quickbooksClient";
afterEach(() => vi.unstubAllGlobals());
describe("QuickBooks signed attachment downloads", () => {
  it("does not send OAuth authorization to signed storage URLs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("check image", {
          headers: { "content-type": "image/png" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const result = await downloadQuickbooksAttachment(
      "private-token",
      "https://files.s3.amazonaws.com/check?X-Amz-Signature=signed",
    );
    expect(fetch.mock.calls[0][1].headers).toEqual({});
    expect(result.contentType).toBe("image/png");
    expect(result.bytes.length).toBeGreaterThan(0);
  });
  it("keeps authentication on the QBO API origin", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("image"));
    vi.stubGlobal("fetch", fetch);
    await downloadQuickbooksAttachment(
      "private-token",
      "https://quickbooks.api.intuit.com/v3/company/1/download/2",
    );
    expect(fetch.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer private-token",
    });
  });
  it("rejects insecure URLs before exposing any token", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      downloadQuickbooksAttachment("private-token", "http://example.com/file"),
    ).rejects.toThrow("HTTPS");
    expect(fetch).not.toHaveBeenCalled();
  });
});
