import { describe, it, expect, vi } from "vitest";
import {
  withRateLimitRetry,
  getRetryAfterMs,
  isRateLimitError,
} from "@workspace/integrations-anthropic-ai";

describe("withRateLimitRetry", () => {
  it("retries transient rate-limit errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRateLimitRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("429 RATELIMIT_EXCEEDED");
        return "ok";
      },
      { minTimeout: 1, maxTimeout: 4, retries: 5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("fails fast on non-rate-limit errors (no retry)", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw new Error("400 invalid_request");
        },
        { minTimeout: 1, maxTimeout: 4, retries: 5 },
      ),
    ).rejects.toThrow("400 invalid_request");
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry(
        async () => {
          calls++;
          throw new Error("429 rate limit");
        },
        { minTimeout: 1, maxTimeout: 4, retries: 2 },
      ),
    ).rejects.toThrow("429");
    // initial attempt + 2 retries
    expect(calls).toBe(3);
  });

  it("honors a retry-after header when longer than the computed backoff", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const err = Object.assign(new Error("429 RATELIMIT_EXCEEDED"), {
      headers: { "retry-after": "1" },
    });
    await withRateLimitRetry(
      async () => {
        calls++;
        if (calls < 2) throw err;
        return "done";
      },
      { minTimeout: 1, maxTimeout: 5000, retries: 3, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    // retry-after of 1s dominates the 1ms backoff
    expect(onRetry.mock.calls[0][0].delayMs).toBe(1000);
  });
});

describe("getRetryAfterMs", () => {
  it("parses retry-after seconds from a plain headers object", () => {
    expect(getRetryAfterMs({ headers: { "retry-after": "30" } })).toBe(30000);
  });

  it("reads from a Headers-like object via .get()", () => {
    const headers = new Headers({ "retry-after": "5" });
    expect(getRetryAfterMs({ headers })).toBe(5000);
  });

  it("returns null when no header is present", () => {
    expect(getRetryAfterMs({ headers: {} })).toBeNull();
    expect(getRetryAfterMs(new Error("boom"))).toBeNull();
    expect(getRetryAfterMs(null)).toBeNull();
  });
});

describe("isRateLimitError", () => {
  it("detects the shared-proxy rate-limit shapes", () => {
    expect(isRateLimitError(new Error("429 RATELIMIT_EXCEEDED"))).toBe(true);
    expect(isRateLimitError(new Error("RESOURCE_EXHAUSTED quota"))).toBe(true);
    expect(isRateLimitError(new Error("rate limit reached"))).toBe(true);
    expect(isRateLimitError(new Error("400 bad request"))).toBe(false);
  });
});
