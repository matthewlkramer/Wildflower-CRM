from pathlib import Path

route = Path("artifacts/api-server/src/routes/appFeedback.ts")
text = route.read_text(encoding="utf-8")
text = text.replace(
    'import { Router, type IRouter } from "express";',
    'import { Router, type IRouter, type Response } from "express";',
    1,
)
text = text.replace(
    "function parseOr400<T>(schema: z.ZodType<T>, value: unknown, res: Parameters<Parameters<typeof asyncHandler>[0]>[1]): T | null {",
    "function parseOr400<T>(schema: z.ZodType<T>, value: unknown, res: Response): T | null {",
    1,
)
text = text.replace(
    '''    const filters: SQL[] = [];
    if (query.status !== "all") filters.push(eq(appFeedback.status, query.status));
    if (query.category !== "all") {
      filters.push(eq(appFeedback.category, query.category));
    }
''',
    '''    const status = query.status ?? "open";
    const category = query.category ?? "all";
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const filters: SQL[] = [];
    if (status !== "all") filters.push(eq(appFeedback.status, status));
    if (category !== "all") {
      filters.push(eq(appFeedback.category, category));
    }
''',
    1,
)
text = text.replace(
    "    const offset = (query.page - 1) * query.limit;",
    "    const offset = (page - 1) * limit;",
    1,
)
text = text.replace(".limit(query.limit)", ".limit(limit)", 1)
text = text.replace(
    '''        page: query.page,
        limit: query.limit,
''',
    '''        page,
        limit,
''',
    1,
)
route.write_text(text, encoding="utf-8")

test = Path("artifacts/api-server/src/__tests__/app-feedback.integration.test.ts")
text = test.read_text(encoding="utf-8")
text = text.replace(
    'currentUser: { id: REPORTER_ID, role: "team_member" as string },',
    'currentUser: { id: "", role: "team_member" as string },',
    1,
)
text = text.replace(
    '}));\n\nvi.mock("../middlewares/requireAuth"',
    '}));\ncurrentUser.id = REPORTER_ID;\n\nvi.mock("../middlewares/requireAuth"',
    1,
)
test.write_text(text, encoding="utf-8")

layout = Path("artifacts/wildflower-crm/src/components/layout.tsx")
text = layout.read_text(encoding="utf-8")
text = text.replace(
    'const isActive = location === item.href || location.startsWith(`${item.href}/`);',
    'const isActive = location === item.href || (item.href !== "/admin" && location.startsWith(`${item.href}/`));',
    1,
)
layout.write_text(text, encoding="utf-8")

dialog = Path("artifacts/wildflower-crm/src/components/feedback-dialog.tsx")
text = dialog.read_text(encoding="utf-8")
text = text.replace(
    "are included when available and can be viewed only by\n              authenticated CRM administrators.",
    "are included when available, stored in the CRM’s private object\n              storage, and added to the administrator review queue.",
    1,
)
dialog.write_text(text, encoding="utf-8")

print("feedback refinements applied")
