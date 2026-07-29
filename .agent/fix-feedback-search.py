from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "artifacts/api-server/src/routes/appFeedback.ts",
    '''    if (query.search) {
      const term = `%${query.search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      filters.push(sql`(''',
    '''    if (query.search) {
      const escapedSearch = query.search.replace(
        /[\\%_]/g,
        (character) => `\\${character}`,
      );
      const term = `%${escapedSearch}%`;
      filters.push(sql`(''',
    "literal wildcard search",
)

path = Path("artifacts/api-server/src/__tests__/app-feedback.integration.test.ts")
text = path.read_text(encoding="utf-8")
text = text.replace(
    "let feedbackId: string | null = null;",
    "const feedbackIds: string[] = [];",
    1,
)
text = text.replace(
    '''  if (feedbackId) {
    await db
      .delete(schema.appFeedback)
      .where(eqFn(schema.appFeedback.id, feedbackId));
  }
''',
    '''  for (const id of feedbackIds) {
    await db.delete(schema.appFeedback).where(eqFn(schema.appFeedback.id, id));
  }
''',
    1,
)
text = text.replace(
    'message: "The completed lens still shows this row.",',
    'message: "The completed lens is 100% wrong for this row.",',
    1,
)
text = text.replace(
    '''    feedbackId = created.json.id;
    expect(created.json).toMatchObject({''',
    '''    const feedbackId = created.json.id as string;
    feedbackIds.push(feedbackId);
    expect(created.json).toMatchObject({''',
    1,
)
text = text.replace(
    '''    const forbidden = await jsonRequest("/api/admin/feedback?status=open");''',
    '''    const unrelated = await jsonRequest("/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        category: "question",
        message: "How should this unrelated queue work?",
        pageUrl: "https://crm.example/dashboard",
        pagePath: "/dashboard",
        pageTitle: "Dashboard",
        context: {},
        screenshotStatus: "skipped",
      }),
    });
    expect(unrelated.status).toBe(201);
    feedbackIds.push(unrelated.json.id as string);

    const forbidden = await jsonRequest("/api/admin/feedback?status=open");''',
    1,
)
text = text.replace(
    '''    expect(listed.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: feedbackId,
          pagePath: "/reconciliation/deposits?lens=all_open",
        }),
      ]),
    );

    const updated = await jsonRequest''',
    '''    expect(listed.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: feedbackId,
          pagePath: "/reconciliation/deposits?lens=all_open",
        }),
      ]),
    );

    const literalWildcard = await jsonRequest(
      `/api/admin/feedback?status=open&search=${encodeURIComponent("%")}`,
    );
    expect(literalWildcard.status).toBe(200);
    expect(literalWildcard.json.data.map((item: { id: string }) => item.id)).toEqual([
      feedbackId,
    ]);

    const updated = await jsonRequest''',
    1,
)
path.write_text(text, encoding="utf-8")

print("literal feedback search fixed")
