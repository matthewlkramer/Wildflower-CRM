export function errorChainIncludes(
  error: unknown,
  needle: string,
  maxDepth = 8,
): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);
    const candidate = current as { message?: unknown; cause?: unknown };
    if (
      typeof candidate.message === "string" &&
      candidate.message.includes(needle)
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
