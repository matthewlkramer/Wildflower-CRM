export type FeedbackCategory = "bug" | "question" | "suggestion" | "other";
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
    const body = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(
      body?.message ?? body?.error ?? `Request failed (${response.status})`,
    );
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
  if (!uploaded.ok)
    throw new Error(`Screenshot upload failed (${uploaded.status})`);
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
  return apiJson<AppFeedbackItem>(
    `/api/admin/feedback/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}
