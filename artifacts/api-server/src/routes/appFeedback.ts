import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { and, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { appFeedback, db, users } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, newId } from "../lib/helpers";

const router: IRouter = Router();
router.use(requireAuth);

const FeedbackCategory = z.enum(["bug", "question", "suggestion", "other"]);
const FeedbackStatus = z.enum(["open", "in_progress", "resolved", "dismissed"]);
const ScreenshotStatus = z.enum(["captured", "failed", "skipped"]);
const ScreenshotUrl = z
  .string()
  .max(2048)
  .regex(
    /^\/api\/storage\/objects\//,
    "Screenshot must use private object storage.",
  );

const CreateFeedbackBody = z.object({
  category: FeedbackCategory.default("bug"),
  message: z.string().trim().min(1).max(10_000),
  pageUrl: z.string().trim().min(1).max(5000),
  pagePath: z.string().trim().min(1).max(3000),
  pageTitle: z.string().trim().max(500).nullable().optional(),
  context: z.record(z.string(), z.unknown()).default({}),
  screenshotUrl: ScreenshotUrl.nullable().optional(),
  screenshotFilename: z.string().trim().max(500).nullable().optional(),
  screenshotStatus: ScreenshotStatus.default("skipped"),
  screenshotError: z.string().trim().max(2000).nullable().optional(),
});

const ListFeedbackQuery = z.object({
  status: z.union([FeedbackStatus, z.literal("all")]).default("open"),
  category: z.union([FeedbackCategory, z.literal("all")]).default("all"),
  search: z.string().trim().max(500).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UpdateFeedbackBody = z
  .object({
    status: FeedbackStatus.optional(),
    adminNotes: z.string().trim().max(20_000).nullable().optional(),
  })
  .refine(
    (value) => value.status !== undefined || value.adminNotes !== undefined,
    {
      message: "At least one feedback field must be updated.",
    },
  );

function parseOr400<T>(
  schema: z.ZodType<T>,
  value: unknown,
  res: Response,
): T | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    res.status(400).json({
      error: "validation_error",
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return null;
  }
  return parsed.data;
}

type UserSummary = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
};

function displayName(user: UserSummary | undefined): string | null {
  if (!user) return null;
  return (
    user.displayName?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email
  );
}

async function usersById(ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, UserSummary>();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      displayName: users.displayName,
    })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

function serializeFeedback(
  row: typeof appFeedback.$inferSelect,
  userMap: Map<string, UserSummary>,
) {
  const reporter = userMap.get(row.createdByUserId);
  const resolver = row.resolvedByUserId
    ? userMap.get(row.resolvedByUserId)
    : undefined;
  return {
    ...row,
    reporter: {
      id: row.createdByUserId,
      name: displayName(reporter),
      email: reporter?.email ?? null,
    },
    resolver: row.resolvedByUserId
      ? {
          id: row.resolvedByUserId,
          name: displayName(resolver),
          email: resolver?.email ?? null,
        }
      : null,
  };
}

router.post(
  "/feedback",
  asyncHandler(async (req, res) => {
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const body = parseOr400(CreateFeedbackBody, req.body, res);
    if (!body) return;
    if (Buffer.byteLength(JSON.stringify(body.context), "utf8") > 200_000) {
      res.status(400).json({
        error: "context_too_large",
        message: "Captured page context is too large.",
      });
      return;
    }

    const [row] = await db
      .insert(appFeedback)
      .values({
        id: `feedback_${newId()}`,
        createdByUserId: actor.id,
        category: body.category,
        message: body.message,
        pageUrl: body.pageUrl,
        pagePath: body.pagePath,
        pageTitle: body.pageTitle ?? null,
        context: body.context,
        screenshotUrl: body.screenshotUrl ?? null,
        screenshotFilename: body.screenshotFilename ?? null,
        screenshotStatus: body.screenshotStatus,
        screenshotError: body.screenshotError ?? null,
      })
      .returning();
    const userMap = await usersById([row.createdByUserId]);
    res.status(201).json(serializeFeedback(row, userMap));
  }),
);

router.get(
  "/admin/feedback",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const query = parseOr400(ListFeedbackQuery, req.query, res);
    if (!query) return;

    const status = query.status ?? "open";
    const category = query.category ?? "all";
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const filters: SQL[] = [];
    if (status !== "all") filters.push(eq(appFeedback.status, status));
    if (category !== "all") {
      filters.push(eq(appFeedback.category, category));
    }
    if (query.search) {
      const escapedSearch = query.search.replace(
        /[\\%_]/g,
        (character) => `\\${character}`,
      );
      const term = `%${escapedSearch}%`;
      filters.push(sql`(
        ${appFeedback.message} ILIKE ${term} ESCAPE '\\'
        OR ${appFeedback.pagePath} ILIKE ${term} ESCAPE '\\'
        OR COALESCE(${appFeedback.pageTitle}, '') ILIKE ${term} ESCAPE '\\'
        OR COALESCE(${appFeedback.adminNotes}, '') ILIKE ${term} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM users feedback_user
          WHERE feedback_user.id = ${appFeedback.createdByUserId}
            AND (
              feedback_user.email ILIKE ${term} ESCAPE '\\'
              OR COALESCE(feedback_user.display_name, '') ILIKE ${term} ESCAPE '\\'
              OR (COALESCE(feedback_user.first_name, '') || ' ' || COALESCE(feedback_user.last_name, '')) ILIKE ${term} ESCAPE '\\'
            )
        )
      )`);
    }
    const where = filters.length ? and(...filters) : undefined;
    const offset = (page - 1) * limit;
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(appFeedback)
        .where(where)
        .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(appFeedback).where(where),
    ]);
    const userMap = await usersById(
      rows.flatMap((row) => [row.createdByUserId, row.resolvedByUserId]),
    );
    res.json({
      data: rows.map((row) => serializeFeedback(row, userMap)),
      pagination: {
        page,
        limit,
        total: Number(totalRows[0]?.value ?? 0),
      },
    });
  }),
);

router.patch(
  "/admin/feedback/:id",
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const actor = getAppUser(req);
    if (!actor?.id) {
      res
        .status(401)
        .json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const id = String(req.params.id ?? "");
    const body = parseOr400(UpdateFeedbackBody, req.body, res);
    if (!body) return;

    const current = await db.query.appFeedback.findFirst({
      where: eq(appFeedback.id, id),
    });
    if (!current) {
      res
        .status(404)
        .json({ error: "not_found", message: "Feedback item not found." });
      return;
    }
    const nextStatus = body.status ?? current.status;
    const terminal = nextStatus === "resolved" || nextStatus === "dismissed";
    const [row] = await db
      .update(appFeedback)
      .set({
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.adminNotes !== undefined
          ? { adminNotes: body.adminNotes }
          : {}),
        resolvedByUserId: terminal ? actor.id : null,
        resolvedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(appFeedback.id, id))
      .returning();
    const userMap = await usersById([
      row.createdByUserId,
      row.resolvedByUserId,
    ]);
    res.json(serializeFeedback(row, userMap));
  }),
);

export default router;
