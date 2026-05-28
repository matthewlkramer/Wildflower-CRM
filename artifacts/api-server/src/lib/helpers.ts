import type { Request, Response, NextFunction, RequestHandler } from "express";
import { nanoid } from "nanoid";

interface ZodLike<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: unknown } };
}

export function newId(): string {
  return nanoid();
}

export function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? String(id[0]) : String(id);
}

export function parsePagination(
  query: { limit?: number; page?: number } | undefined,
): { limit: number; page: number; offset: number } {
  const limit = Math.min(Math.max(query?.limit ?? 50, 1), 10000);
  const page = Math.max(query?.page ?? 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parseOrBadRequest<T>(
  schema: ZodLike<T>,
  input: unknown,
  res: Response,
): T | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      message: "Request validation failed",
      details: { issues: parsed.error.issues },
    });
    return undefined;
  }
  return parsed.data;
}

export function notFound(res: Response, resource = "resource"): void {
  res.status(404).json({ error: "not_found", message: `${resource} not found` });
}

/**
 * Parse a boolean query-string param from req.query. Returns undefined if
 * the param is absent or empty.
 *
 * Why this exists: orval emits `zod.coerce.boolean()` for boolean query
 * params, which uses JS truthiness — so the string "false" coerces to
 * `true` and inverts the filter. Until that's fixed upstream, route
 * handlers should ignore the coerced value on the parsed query object and
 * read the raw value through this helper.
 */
export function parseBoolQuery(
  req: Request,
  name: string,
): boolean | undefined {
  const raw = req.query[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

/**
 * Normalize a query-string value into a `string[]` BEFORE running the
 * orval-generated `array<…>` zod validator. Orval emits form/explode=false
 * arrays as comma-joined single strings (`?status=open,won`), while
 * Express also tolerates repeated keys (`?status=open&status=won`). We
 * accept either, split commas, trim, drop empties. Without this
 * pre-pass, a single-string comma form would 400 against the generated
 * `zod.array(...)` schema before the handler ever runs.
 *
 * Pass an array of `param` names; returns a shallow-cloned `req.query`
 * with each named param coerced to `string[]`.
 */
export function normalizeArrayQuery(
  query: Record<string, unknown>,
  params: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  for (const name of params) {
    const raw = out[name];
    if (raw === undefined || raw === null) continue;
    const collected: string[] = [];
    const consume = (v: unknown) => {
      if (typeof v !== "string") return;
      for (const piece of v.split(",")) {
        const trimmed = piece.trim();
        if (trimmed) collected.push(trimmed);
      }
    };
    if (Array.isArray(raw)) raw.forEach(consume);
    else consume(raw);
    out[name] = collected;
  }
  return out;
}
