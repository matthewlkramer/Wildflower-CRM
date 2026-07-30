from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "artifacts/api-server/src/__tests__/people-org-soft-credit.integration.test.ts",
    '''vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));
''',
    '''vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
''',
    "soft-credit Clerk isolation",
)

replace_once(
    "artifacts/api-server/src/__tests__/donor-routing.integration.test.ts",
    '''  await db
    .delete(schema.donorRoutingPreferences)
    .where(
      inArray(schema.donorRoutingPreferences.sourceKind, [
        "individual",
        "organization",
      ]),
    );
''',
    '''  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourcePersonId, PERSON_ID));
  await db
    .delete(schema.donorRoutingPreferences)
    .where(eq(schema.donorRoutingPreferences.sourceOrganizationId, ORG_ID));
''',
    "donor routing scoped cleanup",
)

print("preferred donor test isolation fixed")
