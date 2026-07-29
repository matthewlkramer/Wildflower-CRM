from pathlib import Path

STUB = '''vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

'''

for filename in [
    "artifacts/api-server/src/__tests__/flag-for-research.integration.test.ts",
    "artifacts/api-server/src/__tests__/flagged-for-research-derivation.integration.test.ts",
]:
    path = Path(filename)
    text = path.read_text(encoding="utf-8")
    if 'vi.mock("@clerk/express"' in text:
        continue
    marker = "type Db = typeof import(\"@workspace/db\");"
    if marker not in text:
        raise SystemExit(f"missing test insertion marker: {filename}")
    path.write_text(text.replace(marker, STUB + marker, 1), encoding="utf-8")

print("cleanup queue Clerk test stubs added")
