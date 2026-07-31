from pathlib import Path
import re


def replace_required(path: str, old: str, new: str, expected: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise RuntimeError(f"Expected {expected} matches in {path} for {old!r}; found {count}")
    p.write_text(text.replace(old, new))


stage_path = "artifacts/api-server/src/lib/pledgeStage.ts"
for name in (
    "commitmentPath",
    "verbalCommitmentAt",
    "pledgeCommittedAt",
    "actualCompletionDate",
):
    replace_required(
        stage_path,
        f"let {name} = input.{name};",
        f"let {name} = input.{name} ?? null;",
    )

route_path = Path("artifacts/api-server/src/routes/opportunitiesAndPledges.ts")
route = route_path.read_text()
# writtenPledge is no longer part of generated request contracts or the bulk
# field vocabulary. Remove the old whitelist item and any create-body read.
route, removed_whitelist = re.subn(
    r'(?m)^\s*"writtenPledge",\n',
    "",
    route,
)
if removed_whitelist < 1:
    raise RuntimeError("Expected at least one writtenPledge bulk-field entry")
route, removed_body = re.subn(
    r'(?m)^\s*writtenPledge:\s*body\.writtenPledge\s*\?\?\s*false,\n',
    "",
    route,
)
if removed_body < 1:
    # Current create code may spread the value rather than assign it directly.
    route, removed_body = re.subn(
        r'(?m)^\s*\.\.\.\(body\.writtenPledge[^\n]*\),\n',
        "",
        route,
    )
if removed_body < 1:
    # Last-resort exact property read: the lifecycle request schema no longer
    # exposes it, so delete the containing single line only.
    lines = route.splitlines(keepends=True)
    kept = [line for line in lines if "body.writtenPledge" not in line]
    removed_body = len(lines) - len(kept)
    route = "".join(kept)
if removed_body < 1:
    raise RuntimeError("Expected a legacy body.writtenPledge create reference")
route_path.write_text(route)
