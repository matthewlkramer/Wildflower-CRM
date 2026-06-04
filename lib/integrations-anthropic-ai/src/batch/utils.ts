import pLimit from "p-limit";
import pRetry, { AbortError } from "p-retry";

/**
 * Batch Processing Utilities
 *
 * Generic batch processing with built-in rate limiting and automatic retries.
 * Use for any task that requires processing multiple items through an LLM or external API.
 *
 * USAGE:
 * ```typescript
 * import { batchProcess } from "@workspace/integrations-anthropic-ai/batch";
 * import { anthropic } from "@workspace/integrations-anthropic-ai";
 *
 * const results = await batchProcess(
 *   artworks,
 *   async (artwork) => {
 *     const message = await anthropic.messages.create({
 *       model: "claude-sonnet-4-6",
 *       max_tokens: 8192,
 *       messages: [{ role: "user", content: `Categorize: ${artwork.name}` }],
 *     });
 *     const block = message.content[0];
 *     return block.type === "text" ? block.text : "";
 *   },
 *   { concurrency: 2, retries: 5 }
 * );
 * ```
 */

export interface BatchOptions {
  concurrency?: number;
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  onProgress?: (completed: number, total: number, item: unknown) => void;
}

export function isRateLimitError(error: unknown): boolean {
  const errorMsg = error instanceof Error ? error.message : String(error);
  return (
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("quota") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

/**
 * Extract a retry delay (ms) from a rate-limit error's headers, if the
 * upstream provided one. Honors both `retry-after` (seconds or an
 * HTTP-date) and the Anthropic-style `anthropic-ratelimit-*-reset`
 * reset-timestamp headers. Duck-types the headers container so this stays
 * env-neutral (works whether the SDK hands us a `Headers`-like object with
 * `.get()` or a plain `Record<string, string>`). Returns null when no
 * usable hint is present.
 */
export function getRetryAfterMs(error: unknown): number | null {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  if (!headers || typeof headers !== "object") return null;

  const read = (name: string): string | null => {
    const getter = (headers as { get?: unknown }).get;
    if (typeof getter === "function") {
      const v = (getter as (n: string) => unknown).call(headers, name);
      return typeof v === "string" ? v : null;
    }
    const rec = headers as Record<string, unknown>;
    const v = rec[name] ?? rec[name.toLowerCase()];
    return typeof v === "string" ? v : null;
  };

  const retryAfter = read("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  const resetAt = read("anthropic-ratelimit-tokens-reset");
  if (resetAt) {
    const dateMs = Date.parse(resetAt);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }

  return null;
}

export interface RateLimitRetryOptions {
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  factor?: number;
  /** Called before each backoff sleep; useful for logging. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry a single async operation through the shared rate-limit/backoff
 * strategy used by `batchProcess`: only transient rate-limit/quota errors
 * (per `isRateLimitError`) are retried with exponential backoff; every
 * other error fails fast. When the upstream supplies a `retry-after` (or
 * Anthropic reset) header we wait at least that long. Use this to make a
 * one-off `anthropic.messages.create` resilient without pulling the call
 * into a batch.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const {
    retries = 7,
    minTimeout = 2000,
    maxTimeout = 128000,
    factor = 2,
    onRetry,
  } = options;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= retries) throw error;
      const backoff = Math.min(maxTimeout, minTimeout * factor ** attempt);
      const retryAfter = getRetryAfterMs(error) ?? 0;
      const delayMs = Math.min(maxTimeout, Math.max(backoff, retryAfter));
      attempt++;
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

export async function batchProcess<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  options: BatchOptions = {}
): Promise<R[]> {
  const {
    concurrency = 2,
    retries = 7,
    minTimeout = 2000,
    maxTimeout = 128000,
    onProgress,
  } = options;

  const limit = pLimit(concurrency);
  let completed = 0;

  const promises = items.map((item, index) =>
    limit(() =>
      pRetry(
        async () => {
          try {
            const result = await processor(item, index);
            completed++;
            onProgress?.(completed, items.length, item);
            return result;
          } catch (error: unknown) {
            if (isRateLimitError(error)) {
              throw error;
            }
            throw new AbortError(
              error instanceof Error ? error : new Error(String(error))
            );
          }
        },
        { retries, minTimeout, maxTimeout, factor: 2 }
      )
    )
  );

  return Promise.all(promises);
}

export async function batchProcessWithSSE<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  sendEvent: (event: { type: string; [key: string]: unknown }) => void,
  options: Omit<BatchOptions, "concurrency" | "onProgress"> = {}
): Promise<R[]> {
  const { retries = 5, minTimeout = 1000, maxTimeout = 15000 } = options;

  sendEvent({ type: "started", total: items.length });

  const results: R[] = [];
  let errors = 0;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    sendEvent({ type: "processing", index, item });

    try {
      const result = await pRetry(
        () => processor(item, index),
        {
          retries,
          minTimeout,
          maxTimeout,
          factor: 2,
          onFailedAttempt: (error) => {
            if (!isRateLimitError(error)) {
              throw new AbortError(
                error instanceof Error ? error : new Error(String(error))
              );
            }
          },
        }
      );
      results.push(result);
      sendEvent({ type: "progress", index, result });
    } catch (error) {
      errors++;
      results.push(undefined as R);
      sendEvent({
        type: "progress",
        index,
        error: error instanceof Error ? error.message : "Processing failed",
      });
    }
  }

  sendEvent({ type: "complete", processed: items.length, errors });
  return results;
}
