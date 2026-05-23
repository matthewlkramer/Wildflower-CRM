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
  const limit = Math.min(Math.max(query?.limit ?? 50, 1), 1000);
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
