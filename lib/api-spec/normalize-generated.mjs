import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Shared by regeneration and its non-mutating check. Orval bodyless templates
// emit trailing spaces and an extra EOF line. Normalize only the affected tags.
const root = resolve(process.argv[2] ?? "../..");
for (const tag of ["calendar-events", "feedback", "reconciliation", "gifts-and-payments", "opportunities-and-pledges", "organizations", "people"]) {
  const file = resolve(root, `lib/api-client-react/src/generated/${tag}/${tag}.ts`);
  const text = readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trimEnd()).join("\n").trimEnd() + "\n";
  writeFileSync(file, text);
}
