from __future__ import annotations

import json
from pathlib import Path


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


write(
    "lib/db/src/schema/appFeedback.ts",
    '''import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export type AppFeedbackContext = Record<string, unknown>;

/**
 * User-submitted product feedback with enough page context to reproduce the
 * issue. Screenshots live in the existing private object store; this table
 * keeps only the authenticated object URL.
 */
export const appFeedback = pgTable(
  "app_feedback",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    category: text("category").notNull().default("bug"),
    message: text("message").notNull(),
    status: text("status").notNull().default("open"),
    pageUrl: text("page_url").notNull(),
    pagePath: text("page_path").notNull(),
    pageTitle: text("page_title"),
    context: jsonb("context")
      .$type<AppFeedbackContext>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    screenshotUrl: text("screenshot_url"),
    screenshotFilename: text("screenshot_filename"),
    screenshotStatus: text("screenshot_status").notNull().default("skipped"),
    screenshotError: text("screenshot_error"),
    adminNotes: text("admin_notes"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "app_feedback_category_ck",
      sql`${t.category} IN ('bug', 'question', 'suggestion', 'other')`,
    ),
    check(
      "app_feedback_status_ck",
      sql`${t.status} IN ('open', 'in_progress', 'resolved', 'dismissed')`,
    ),
    check(
      "app_feedback_screenshot_status_ck",
      sql`${t.screenshotStatus} IN ('captured', 'failed', 'skipped')`,
    ),
    index("app_feedback_status_created_idx").on(t.status, t.createdAt),
    index("app_feedback_creator_created_idx").on(
      t.createdByUserId,
      t.createdAt,
    ),
    index("app_feedback_created_idx").on(t.createdAt),
  ],
);

export type AppFeedback = typeof appFeedback.$inferSelect;
export type NewAppFeedback = typeof appFeedback.$inferInsert;
''',
)

write(
    "lib/db/migrations/0219_app_feedback.sql",
    '''-- Private in-app product feedback queue. Screenshots are stored in the
-- existing authenticated object store; only their relative URL is persisted.

CREATE TABLE IF NOT EXISTS app_feedback (
  id text PRIMARY KEY,
  created_by_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category text NOT NULL DEFAULT 'bug',
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  page_url text NOT NULL,
  page_path text NOT NULL,
  page_title text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  screenshot_url text,
  screenshot_filename text,
  screenshot_status text NOT NULL DEFAULT 'skipped',
  screenshot_error text,
  admin_notes text,
  resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_feedback_category_ck
    CHECK (category IN ('bug', 'question', 'suggestion', 'other')),
  CONSTRAINT app_feedback_status_ck
    CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
  CONSTRAINT app_feedback_screenshot_status_ck
    CHECK (screenshot_status IN ('captured', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS app_feedback_status_created_idx
  ON app_feedback(status, created_at);
CREATE INDEX IF NOT EXISTS app_feedback_creator_created_idx
  ON app_feedback(created_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS app_feedback_created_idx
  ON app_feedback(created_at);
''',
)

replace_once(
    "lib/db/src/schema/index.ts",
    'export * from "./auditLog";\n',
    'export * from "./auditLog";\nexport * from "./appFeedback";\n',
    "schema export",
)

write(
    "artifacts/api-server/src/routes/appFeedback.ts",
    '''import { Router, type IRouter } from "express";
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
  .regex(/^\/api\/storage\/objects\//, "Screenshot must use private object storage.");

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
  .refine((value) => value.status !== undefined || value.adminNotes !== undefined, {
    message: "At least one feedback field must be updated.",
  });

function parseOr400<T>(schema: z.ZodType<T>, value: unknown, res: Parameters<Parameters<typeof asyncHandler>[0]>[1]): T | null {
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
      res.status(401).json({ error: "unauthorized", message: "Sign in required." });
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

    const filters: SQL[] = [];
    if (query.status !== "all") filters.push(eq(appFeedback.status, query.status));
    if (query.category !== "all") {
      filters.push(eq(appFeedback.category, query.category));
    }
    if (query.search) {
      const term = `%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
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
    const offset = (query.page - 1) * query.limit;
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(appFeedback)
        .where(where)
        .orderBy(desc(appFeedback.createdAt), desc(appFeedback.id))
        .limit(query.limit)
        .offset(offset),
      db.select({ value: count() }).from(appFeedback).where(where),
    ]);
    const userMap = await usersById(
      rows.flatMap((row) => [row.createdByUserId, row.resolvedByUserId]),
    );
    res.json({
      data: rows.map((row) => serializeFeedback(row, userMap)),
      pagination: {
        page: query.page,
        limit: query.limit,
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
      res.status(401).json({ error: "unauthorized", message: "Sign in required." });
      return;
    }
    const id = String(req.params.id ?? "");
    const body = parseOr400(UpdateFeedbackBody, req.body, res);
    if (!body) return;

    const current = await db.query.appFeedback.findFirst({
      where: eq(appFeedback.id, id),
    });
    if (!current) {
      res.status(404).json({ error: "not_found", message: "Feedback item not found." });
      return;
    }
    const nextStatus = body.status ?? current.status;
    const terminal = nextStatus === "resolved" || nextStatus === "dismissed";
    const [row] = await db
      .update(appFeedback)
      .set({
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.adminNotes !== undefined ? { adminNotes: body.adminNotes } : {}),
        resolvedByUserId: terminal ? actor.id : null,
        resolvedAt: terminal ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(appFeedback.id, id))
      .returning();
    const userMap = await usersById([row.createdByUserId, row.resolvedByUserId]);
    res.json(serializeFeedback(row, userMap));
  }),
);

export default router;
''',
)

replace_once(
    "artifacts/api-server/src/routes/index.ts",
    'import auditLogRouter from "./auditLog";\n',
    'import auditLogRouter from "./auditLog";\nimport appFeedbackRouter from "./appFeedback";\n',
    "feedback route import",
)
replace_once(
    "artifacts/api-server/src/routes/index.ts",
    "router.use(auditLogRouter);\n",
    "router.use(auditLogRouter);\nrouter.use(appFeedbackRouter);\n",
    "feedback route mount",
)

write(
    "artifacts/wildflower-crm/src/lib/feedback-api.ts",
    '''export type FeedbackCategory = "bug" | "question" | "suggestion" | "other";
export type FeedbackStatus = "open" | "in_progress" | "resolved" | "dismissed";
export type ScreenshotStatus = "captured" | "failed" | "skipped";

export type FeedbackContext = {
  capturedAt: string;
  url: string;
  pathname: string;
  search: string;
  hash: string;
  pageTitle: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  screen: { width: number; height: number };
  scroll: { x: number; y: number };
  browser: {
    userAgent: string;
    language: string;
    platform: string;
    timezone: string;
  };
  activeTabs: string[];
  activeControls: string[];
  controls: Array<{ label: string; value: string; kind: string }>;
  visibleTestIds: string[];
};

export type FeedbackPerson = {
  id: string;
  name: string | null;
  email: string | null;
};

export type AppFeedbackItem = {
  id: string;
  createdByUserId: string;
  category: FeedbackCategory;
  message: string;
  status: FeedbackStatus;
  pageUrl: string;
  pagePath: string;
  pageTitle: string | null;
  context: FeedbackContext;
  screenshotUrl: string | null;
  screenshotFilename: string | null;
  screenshotStatus: ScreenshotStatus;
  screenshotError: string | null;
  adminNotes: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reporter: FeedbackPerson;
  resolver: FeedbackPerson | null;
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string; error?: string }
      | null;
    throw new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function uploadFeedbackScreenshot(file: File): Promise<string> {
  const request = await apiJson<{ uploadURL: string; objectPath: string }>(
    "/api/storage/uploads/request-url",
    {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        contentType: file.type || "image/jpeg",
      }),
    },
  );
  const uploaded = await fetch(request.uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type || "image/jpeg" },
    body: file,
  });
  if (!uploaded.ok) throw new Error(`Screenshot upload failed (${uploaded.status})`);
  return `/api/storage${request.objectPath}`;
}

export async function createAppFeedback(input: {
  category: FeedbackCategory;
  message: string;
  pageUrl: string;
  pagePath: string;
  pageTitle: string | null;
  context: FeedbackContext;
  screenshotUrl: string | null;
  screenshotFilename: string | null;
  screenshotStatus: ScreenshotStatus;
  screenshotError: string | null;
}): Promise<AppFeedbackItem> {
  return apiJson<AppFeedbackItem>("/api/feedback", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAppFeedback(params: {
  status: FeedbackStatus | "all";
  category: FeedbackCategory | "all";
  search?: string;
  page: number;
  limit: number;
}): Promise<{
  data: AppFeedbackItem[];
  pagination: { page: number; limit: number; total: number };
}> {
  const query = new URLSearchParams({
    status: params.status,
    category: params.category,
    page: String(params.page),
    limit: String(params.limit),
  });
  if (params.search?.trim()) query.set("search", params.search.trim());
  return apiJson(`/api/admin/feedback?${query}`);
}

export async function updateAppFeedback(
  id: string,
  input: { status?: FeedbackStatus; adminNotes?: string | null },
): Promise<AppFeedbackItem> {
  return apiJson<AppFeedbackItem>(`/api/admin/feedback/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
''',
)

write(
    "artifacts/wildflower-crm/src/lib/feedback-capture.ts",
    '''import type { FeedbackContext } from "./feedback-api";

const MAX_CONTROLS = 60;
const MAX_TEST_IDS = 120;
const MAX_VALUE = 300;

function truncate(value: string, max = MAX_VALUE): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.closest('[aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= window.innerHeight &&
    rect.left <= window.innerWidth
  );
}

function controlLabel(element: HTMLElement): string {
  const id = element.id;
  const explicitLabel = id
    ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
        ?.textContent
    : null;
  return truncate(
    (
      explicitLabel ||
      element.getAttribute("aria-label") ||
      element.getAttribute("name") ||
      element.getAttribute("data-testid") ||
      element.getAttribute("placeholder") ||
      element.textContent ||
      element.tagName.toLowerCase()
    ).trim(),
    160,
  );
}

function controlValue(element: HTMLElement): { value: string; kind: string } | null {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (["password", "file", "hidden"].includes(type)) return null;
    if (["checkbox", "radio"].includes(type)) {
      return { value: element.checked ? "checked" : "not checked", kind: type };
    }
    return { value: truncate(element.value), kind: type || "input" };
  }
  if (element instanceof HTMLTextAreaElement) {
    return { value: truncate(element.value), kind: "textarea" };
  }
  if (element instanceof HTMLSelectElement) {
    return {
      value: truncate(
        Array.from(element.selectedOptions)
          .map((option) => option.textContent?.trim() || option.value)
          .join(", "),
      ),
      kind: "select",
    };
  }
  if (element.getAttribute("role") === "combobox") {
    return {
      value: truncate(
        element.getAttribute("aria-valuetext") || element.textContent?.trim() || "",
      ),
      kind: "combobox",
    };
  }
  return null;
}

export function collectFeedbackContext(): FeedbackContext {
  const root = document.querySelector("main") ?? document.body;
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, textarea, select, [role="combobox"]',
    ),
  )
    .filter(visible)
    .flatMap((element) => {
      const captured = controlValue(element);
      return captured
        ? [{ label: controlLabel(element), value: captured.value, kind: captured.kind }]
        : [];
    })
    .slice(0, MAX_CONTROLS);

  const activeTabs = Array.from(
    root.querySelectorAll<HTMLElement>('[role="tab"][data-state="active"]'),
  )
    .filter(visible)
    .map((element) => truncate(element.textContent?.trim() || "Active tab", 160));

  const activeControls = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[aria-pressed="true"], [aria-current="page"], [data-state="on"]',
    ),
  )
    .filter(visible)
    .map(controlLabel)
    .slice(0, 40);

  const visibleTestIds = Array.from(
    root.querySelectorAll<HTMLElement>("[data-testid]"),
  )
    .filter(visible)
    .map((element) => element.dataset.testid || "")
    .filter(Boolean)
    .slice(0, MAX_TEST_IDS);

  return {
    capturedAt: new Date().toISOString(),
    url: window.location.href,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    pageTitle: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    screen: {
      width: window.screen?.width ?? window.innerWidth,
      height: window.screen?.height ?? window.innerHeight,
    },
    scroll: { x: window.scrollX, y: window.scrollY },
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    activeTabs,
    activeControls,
    controls,
    visibleTestIds,
  };
}

function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  return fetch(dataUrl)
    .then((response) => response.blob())
    .then((blob) => new File([blob], filename, { type: blob.type || "image/jpeg" }));
}

export async function captureFeedbackScreenshot(): Promise<File> {
  const { toJpeg } = await import("html-to-image");
  const root = document.documentElement;
  const render = (quality: number, pixelRatio: number) =>
    toJpeg(root, {
      quality,
      pixelRatio,
      cacheBust: true,
      width: window.innerWidth,
      height: window.innerHeight,
      canvasWidth: Math.max(1, Math.round(window.innerWidth * pixelRatio)),
      canvasHeight: Math.max(1, Math.round(window.innerHeight * pixelRatio)),
      style: {
        transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
        transformOrigin: "top left",
      },
      filter: (node) => {
        if (!(node instanceof HTMLElement)) return true;
        return !node.closest("[data-feedback-ignore]");
      },
    });

  let file = await dataUrlToFile(
    await render(0.72, Math.min(window.devicePixelRatio || 1, 1.15)),
    `feedback-${new Date().toISOString().replaceAll(":", "-")}.jpg`,
  );
  if (file.size > 2_500_000) {
    file = await dataUrlToFile(
      await render(0.55, 0.8),
      `feedback-${new Date().toISOString().replaceAll(":", "-")}.jpg`,
    );
  }
  if (file.size > 5_000_000) {
    throw new Error("The screenshot was too large to attach.");
  }
  return file;
}
''',
)

write(
    "artifacts/wildflower-crm/src/components/feedback-dialog.tsx",
    '''import { useEffect, useState } from "react";
import { Camera, Loader2, MessageSquare, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  createAppFeedback,
  uploadFeedbackScreenshot,
  type FeedbackCategory,
  type FeedbackContext,
} from "@/lib/feedback-api";
import {
  captureFeedbackScreenshot,
  collectFeedbackContext,
} from "@/lib/feedback-capture";

export function FeedbackDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [context, setContext] = useState<FeedbackContext | null>(null);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!screenshot) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(screenshot);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot]);

  const capture = async () => {
    setScreenshot(null);
    setScreenshotError(null);
    try {
      setScreenshot(await captureFeedbackScreenshot());
    } catch (error) {
      setScreenshotError(
        error instanceof Error ? error.message : "Screenshot capture failed.",
      );
    }
  };

  const beginFeedback = async () => {
    setPreparing(true);
    setContext(collectFeedbackContext());
    await capture();
    setOpen(true);
    setPreparing(false);
  };

  const reset = () => {
    setCategory("bug");
    setMessage("");
    setContext(null);
    setScreenshot(null);
    setScreenshotError(null);
  };

  const submit = async () => {
    if (!context || !message.trim()) return;
    setSubmitting(true);
    let screenshotUrl: string | null = null;
    let finalScreenshotError = screenshotError;
    let screenshotStatus: "captured" | "failed" | "skipped" = screenshot
      ? "captured"
      : screenshotError
        ? "failed"
        : "skipped";
    if (screenshot) {
      try {
        screenshotUrl = await uploadFeedbackScreenshot(screenshot);
      } catch (error) {
        screenshotStatus = "failed";
        finalScreenshotError =
          error instanceof Error ? error.message : "Screenshot upload failed.";
      }
    }

    try {
      await createAppFeedback({
        category,
        message: message.trim(),
        pageUrl: context.url,
        pagePath: `${context.pathname}${context.search}${context.hash}`,
        pageTitle: context.pageTitle || null,
        context,
        screenshotUrl,
        screenshotFilename: screenshotUrl ? screenshot?.name ?? null : null,
        screenshotStatus,
        screenshotError: finalScreenshotError,
      });
      setOpen(false);
      reset();
      toast({
        title: "Feedback submitted",
        description: screenshotUrl
          ? "Your note, page state, and screenshot were saved."
          : "Your note and page state were saved.",
      });
    } catch (error) {
      toast({
        title: "Could not submit feedback",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void beginFeedback()}
        disabled={preparing}
        data-feedback-ignore
        data-testid="button-feedback"
      >
        {preparing ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MessageSquare className="mr-2 h-4 w-4" />
        )}
        Feedback
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && !submitting) reset();
        }}
      >
        <DialogContent className="max-w-2xl" data-feedback-ignore>
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Describe the issue or question. A private screenshot and the current
              page state are included when available and can be viewed only by
              authenticated CRM administrators.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={category}
                onValueChange={(value) => setCategory(value as FeedbackCategory)}
              >
                <SelectTrigger data-testid="select-feedback-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bug">Something is not working</SelectItem>
                  <SelectItem value="question">Question</SelectItem>
                  <SelectItem value="suggestion">Suggestion</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="feedback-message">Issue or question</Label>
              <Textarea
                id="feedback-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="What were you trying to do, and what happened?"
                rows={6}
                maxLength={10_000}
                autoFocus
                data-testid="textarea-feedback-message"
              />
            </div>

            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Current-page screenshot</p>
                  <p className="text-xs text-muted-foreground">
                    Captured before this dialog opened.
                  </p>
                </div>
                {screenshot ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setScreenshot(null);
                      setScreenshotError(null);
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => void capture()}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Try capture
                  </Button>
                )}
              </div>
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Feedback screenshot preview"
                  className="mt-3 max-h-64 w-full rounded border object-contain"
                />
              ) : screenshotError ? (
                <p className="mt-3 text-xs text-amber-700">
                  <Camera className="mr-1 inline h-3.5 w-3.5" />
                  Screenshot unavailable: {screenshotError}
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  No screenshot will be included.
                </p>
              )}
            </div>

            {context ? (
              <p className="text-xs text-muted-foreground">
                Page: <span className="font-mono">{context.pathname}</span> ·
                viewport {context.viewport.width}×{context.viewport.height}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={submitting || !message.trim() || !context}
              data-testid="button-submit-feedback"
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Submit feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
''',
)

write(
    "artifacts/wildflower-crm/src/pages/admin-feedback.tsx",
    '''import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ImageOff, Loader2, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useToast } from "@/hooks/use-toast";
import {
  listAppFeedback,
  updateAppFeedback,
  type AppFeedbackItem,
  type FeedbackCategory,
  type FeedbackContext,
  type FeedbackStatus,
} from "@/lib/feedback-api";

const PAGE_SIZE = 50;

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function categoryLabel(category: FeedbackCategory): string {
  return {
    bug: "Problem",
    question: "Question",
    suggestion: "Suggestion",
    other: "Other",
  }[category];
}

function statusLabel(status: FeedbackStatus): string {
  return {
    open: "Open",
    in_progress: "In progress",
    resolved: "Resolved",
    dismissed: "Dismissed",
  }[status];
}

function statusVariant(status: FeedbackStatus): "default" | "secondary" | "outline" {
  if (status === "open") return "default";
  if (status === "in_progress") return "secondary";
  return "outline";
}

export default function AdminFeedback() {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<FeedbackStatus | "all">("open");
  const [category, setCategory] = useState<FeedbackCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AppFeedbackItem | null>(null);
  const [editStatus, setEditStatus] = useState<FeedbackStatus>("open");
  const [adminNotes, setAdminNotes] = useState("");

  useEffect(() => setPage(1), [status, category, search]);
  useEffect(() => {
    if (!selected) return;
    setEditStatus(selected.status);
    setAdminNotes(selected.adminNotes ?? "");
  }, [selected]);

  const queryKey = useMemo(
    () => ["admin-feedback", status, category, search, page] as const,
    [status, category, search, page],
  );
  const feedbackQuery = useQuery({
    queryKey,
    enabled: isAdmin,
    queryFn: () =>
      listAppFeedback({
        status,
        category,
        search: search.trim() || undefined,
        page,
        limit: PAGE_SIZE,
      }),
  });
  const updateMutation = useMutation({
    mutationFn: ({
      id,
      nextStatus,
      notes,
    }: {
      id: string;
      nextStatus: FeedbackStatus;
      notes: string;
    }) =>
      updateAppFeedback(id, {
        status: nextStatus,
        adminNotes: notes.trim() || null,
      }),
    onSuccess: (updated) => {
      setSelected(updated);
      void queryClient.invalidateQueries({ queryKey: ["admin-feedback"] });
      toast({ title: "Feedback updated" });
    },
    onError: (error) => {
      toast({
        title: "Could not update feedback",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  if (!isAdmin) {
    return (
      <Card className="max-w-xl">
        <CardContent className="pt-6">
          <p className="font-medium">Admin access required</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only administrators can review submitted product feedback.
          </p>
        </CardContent>
      </Card>
    );
  }

  const data = feedbackQuery.data?.data ?? [];
  const total = feedbackQuery.data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const context = selected?.context as FeedbackContext | undefined;

  return (
    <div className="max-w-7xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-serif font-bold">
          <MessageSquare className="h-7 w-7 text-primary" />
          Feedback
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review questions and issues submitted from inside the CRM, including
          page state and a private screenshot when capture succeeded.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search message, page, or reporter…"
          className="max-w-sm"
        />
        <Select value={status} onValueChange={(value) => setStatus(value as FeedbackStatus | "all")}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="in_progress">In progress</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={(value) => setCategory(value as FeedbackCategory | "all")}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="bug">Problems</SelectItem>
            <SelectItem value="question">Questions</SelectItem>
            <SelectItem value="suggestion">Suggestions</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          {total.toLocaleString()} items
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-40">Submitted</TableHead>
              <TableHead className="w-44">Reporter</TableHead>
              <TableHead className="w-28">Type</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-52">Page</TableHead>
              <TableHead className="w-32">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {feedbackQuery.isLoading ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow>
            ) : data.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No feedback matches these filters.</TableCell></TableRow>
            ) : (
              data.map((item) => (
                <TableRow key={item.id} className="cursor-pointer" onClick={() => setSelected(item)}>
                  <TableCell className="text-xs">{fmtDate(item.createdAt)}</TableCell>
                  <TableCell>
                    <div className="text-sm font-medium">{item.reporter.name ?? "Unknown user"}</div>
                    <div className="truncate text-xs text-muted-foreground">{item.reporter.email}</div>
                  </TableCell>
                  <TableCell><Badge variant="outline">{categoryLabel(item.category)}</Badge></TableCell>
                  <TableCell><p className="line-clamp-2 max-w-xl whitespace-pre-wrap text-sm">{item.message}</p></TableCell>
                  <TableCell className="font-mono text-xs">{item.pagePath}</TableCell>
                  <TableCell><Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge></TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <Button variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
        <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
        <Button variant="outline" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
      </div>

      <Dialog open={selected != null} onOpenChange={(next) => !next && setSelected(null)}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{categoryLabel(selected.category)}</Badge>
                  Feedback from {selected.reporter.name ?? selected.reporter.email ?? "a user"}
                </DialogTitle>
                <DialogDescription>
                  Submitted {fmtDate(selected.createdAt)} from {selected.pagePath}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(280px,0.7fr)]">
                <div className="space-y-5">
                  <section>
                    <h3 className="text-sm font-semibold">Issue or question</h3>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 text-sm">{selected.message}</p>
                  </section>
                  <section>
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">Screenshot</h3>
                      {selected.screenshotUrl ? (
                        <a href={selected.screenshotUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                          Open full size <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    {selected.screenshotUrl ? (
                      <a href={selected.screenshotUrl} target="_blank" rel="noreferrer">
                        <img src={selected.screenshotUrl} alt="Submitted feedback screenshot" className="mt-2 max-h-[520px] w-full rounded-lg border object-contain" />
                      </a>
                    ) : (
                      <div className="mt-2 flex min-h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                        <ImageOff className="mr-2 h-4 w-4" />
                        {selected.screenshotError ? `Capture failed: ${selected.screenshotError}` : "No screenshot included"}
                      </div>
                    )}
                  </section>
                </div>

                <div className="space-y-5">
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">Page context</h3>
                    <a href={selected.pageUrl} target="_blank" rel="noreferrer" className="block break-all text-sm text-primary hover:underline">{selected.pageUrl}</a>
                    {context ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <p>Viewport: {context.viewport.width}×{context.viewport.height}</p>
                        <p>Scroll: {context.scroll.x}, {context.scroll.y}</p>
                        <p>Tabs: {context.activeTabs.join(", ") || "none"}</p>
                        <p>Visible records/elements: {context.visibleTestIds.length}</p>
                      </div>
                    ) : null}
                    <details className="rounded border p-2 text-xs">
                      <summary className="cursor-pointer font-medium">Full captured state</summary>
                      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[10px]">{JSON.stringify(selected.context, null, 2)}</pre>
                    </details>
                  </section>

                  <section className="space-y-3 rounded-lg border p-4">
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <Select value={editStatus} onValueChange={(value) => setEditStatus(value as FeedbackStatus)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="open">Open</SelectItem>
                          <SelectItem value="in_progress">In progress</SelectItem>
                          <SelectItem value="resolved">Resolved</SelectItem>
                          <SelectItem value="dismissed">Dismissed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="feedback-admin-notes">Admin notes</Label>
                      <Textarea id="feedback-admin-notes" value={adminNotes} onChange={(event) => setAdminNotes(event.target.value)} rows={8} placeholder="Investigation, decision, or follow-up…" />
                    </div>
                    {selected.resolver ? (
                      <p className="text-xs text-muted-foreground">Last resolved by {selected.resolver.name ?? selected.resolver.email} {selected.resolvedAt ? `on ${fmtDate(selected.resolvedAt)}` : ""}</p>
                    ) : null}
                  </section>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
                <Button
                  onClick={() => updateMutation.mutate({ id: selected.id, nextStatus: editStatus, notes: adminNotes })}
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
''',
)

write(
    "artifacts/wildflower-crm/src/lib/feedback-capture.test.ts",
    '''// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFeedbackContext } from "./feedback-capture";

const rect = {
  x: 10,
  y: 10,
  top: 10,
  left: 10,
  right: 210,
  bottom: 40,
  width: 200,
  height: 30,
  toJSON: () => ({}),
};

describe("feedback page-state capture", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("captures visible filters and selected tabs while excluding sensitive controls", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
    window.history.pushState({}, "", "/reconciliation/deposits?lens=needs_gift");
    document.body.innerHTML = `
      <main>
        <button role="tab" data-state="active">Needs gift</button>
        <input aria-label="Search deposits" value="Erica Cantoni" />
        <input type="password" aria-label="Secret" value="do-not-capture" />
        <button aria-pressed="true">Show excluded</button>
        <div data-testid="deposit-row-bdep_123">Row</div>
      </main>
    `;

    const context = collectFeedbackContext();
    expect(context.pathname).toBe("/reconciliation/deposits");
    expect(context.search).toBe("?lens=needs_gift");
    expect(context.activeTabs).toEqual(["Needs gift"]);
    expect(context.activeControls).toContain("Show excluded");
    expect(context.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Search deposits",
          value: "Erica Cantoni",
        }),
      ]),
    );
    expect(context.controls.some((control) => control.value === "do-not-capture")).toBe(false);
    expect(context.visibleTestIds).toContain("deposit-row-bdep_123");
  });
});
''',
)

write(
    "artifacts/api-server/src/__tests__/app-feedback.integration.test.ts",
    '''import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB = !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `appfeedback_${Date.now()}`;
const REPORTER_ID = `${RUN}_reporter`;
const ADMIN_ID = `${RUN}_admin`;

const { currentUser } = vi.hoisted(() => ({
  currentUser: { id: REPORTER_ID, role: "team_member" as string },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { ...currentUser };
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let eqFn: (typeof import("drizzle-orm"))["eq"];
let server: Server;
let baseUrl = "";
let feedbackId: string | null = null;

async function jsonRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  return {
    status: response.status,
    json: response.status === 204 ? null : await response.json(),
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  eqFn = (await import("drizzle-orm")).eq;
  await db.insert(schema.users).values([
    {
      id: REPORTER_ID,
      clerkId: `clerk_${REPORTER_ID}`,
      email: `${REPORTER_ID}@wildflowerschools.org`,
      displayName: "Feedback Reporter",
      role: "team_member",
    },
    {
      id: ADMIN_ID,
      clerkId: `clerk_${ADMIN_ID}`,
      email: `${ADMIN_ID}@wildflowerschools.org`,
      displayName: "Feedback Admin",
      role: "admin",
    },
  ]);
  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (feedbackId) {
    await db.delete(schema.appFeedback).where(eqFn(schema.appFeedback.id, feedbackId));
  }
  await db.delete(schema.users).where(eqFn(schema.users.id, REPORTER_ID));
  await db.delete(schema.users).where(eqFn(schema.users.id, ADMIN_ID));
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}, 60_000);

describe.skipIf(!HAS_DB)("app feedback API", () => {
  it("accepts team feedback and exposes an admin-only resolution queue", async () => {
    const created = await jsonRequest("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        category: "bug",
        message: "The completed lens still shows this row.",
        pageUrl: "https://crm.example/reconciliation/deposits?lens=all_open",
        pagePath: "/reconciliation/deposits?lens=all_open",
        pageTitle: "Reconciliation",
        context: {
          viewport: { width: 1440, height: 900 },
          visibleTestIds: ["deposit-row-bdep_123"],
        },
        screenshotUrl: "/api/storage/objects/feedback-test.jpg",
        screenshotFilename: "feedback-test.jpg",
        screenshotStatus: "captured",
      }),
    });
    expect(created.status).toBe(201);
    feedbackId = created.json.id;
    expect(created.json).toMatchObject({
      status: "open",
      reporter: { id: REPORTER_ID, name: "Feedback Reporter" },
      screenshotStatus: "captured",
    });

    const forbidden = await jsonRequest("/api/admin/feedback?status=open");
    expect(forbidden.status).toBe(403);

    currentUser.id = ADMIN_ID;
    currentUser.role = "admin";
    const listed = await jsonRequest(
      "/api/admin/feedback?status=open&search=completed%20lens",
    );
    expect(listed.status).toBe(200);
    expect(listed.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: feedbackId,
          pagePath: "/reconciliation/deposits?lens=all_open",
        }),
      ]),
    );

    const updated = await jsonRequest(`/api/admin/feedback/${feedbackId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "resolved",
        adminNotes: "Fixed in the deposit completion patch.",
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({
      status: "resolved",
      adminNotes: "Fixed in the deposit completion patch.",
      resolvedByUserId: ADMIN_ID,
    });
    expect(updated.json.resolvedAt).toBeTruthy();
  });
});
''',
)

replace_once(
    "artifacts/wildflower-crm/src/components/layout.tsx",
    'import { AddMeetingNoteDialog } from "@/components/meeting-notes-panel";\n',
    'import { AddMeetingNoteDialog } from "@/components/meeting-notes-panel";\nimport { FeedbackDialog } from "@/components/feedback-dialog";\n',
    "feedback dialog import",
)
replace_once(
    "artifacts/wildflower-crm/src/components/layout.tsx",
    '  { href: "/admin", label: "Admin", icon: Settings },\n',
    '  { href: "/admin", label: "Admin", icon: Settings },\n  { href: "/admin/feedback", label: "Feedback", icon: MessageSquare, adminOnly: true },\n',
    "feedback nav item",
)
replace_once(
    "artifacts/wildflower-crm/src/components/layout.tsx",
    '          <div className="flex items-center gap-2">\n            <AddMeetingNoteDialog unpinned />\n',
    '          <div className="flex items-center gap-2">\n            <FeedbackDialog />\n            <AddMeetingNoteDialog unpinned />\n',
    "feedback header button",
)

replace_once(
    "artifacts/wildflower-crm/src/App.tsx",
    'import Admin from "@/pages/admin";\n',
    'import Admin from "@/pages/admin";\nimport AdminFeedback from "@/pages/admin-feedback";\n',
    "feedback page import",
)
replace_once(
    "artifacts/wildflower-crm/src/App.tsx",
    '          <Route path="/admin"><ProtectedRoute component={Admin} /></Route>\n',
    '          <Route path="/admin"><ProtectedRoute component={Admin} /></Route>\n          <Route path="/admin/feedback"><ProtectedRoute component={AdminFeedback} /></Route>\n',
    "feedback page route",
)

package_path = Path("artifacts/wildflower-crm/package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
package.setdefault("dependencies", {})["html-to-image"] = "^1.11.13"
package["dependencies"] = dict(sorted(package["dependencies"].items()))
package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

print("app feedback feature staged")
