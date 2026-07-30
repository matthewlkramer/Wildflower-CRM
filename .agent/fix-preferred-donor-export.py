from pathlib import Path
import re

path = Path("scripts/src/export-donor-attribution.ts")
text = path.read_text(encoding="utf-8")
text = text.replace('import { asc } from "drizzle-orm";\n', '')
text, count = re.subn(r'\s*\.orderBy\(asc\([^\n]+\)\)', '', text)
if count < 10:
    raise SystemExit(f"Expected to remove export ordering calls, removed {count}")
path.write_text(text, encoding="utf-8")
print(f"removed {count} unnecessary export ordering calls")
