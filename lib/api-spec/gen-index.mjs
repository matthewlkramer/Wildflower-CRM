// Generates the `index.ts` barrel for each per-tag (tags-split) orval output.
//
// orval's tags-split mode writes one file per tag (e.g. `generated/people/people.ts`)
// plus a shared `generated/api.schemas.ts` (react-query only), but it does NOT emit a
// root barrel re-exporting the hooks. We generate that barrel here so the package
// entry points can keep doing `export * from "./generated"` and every existing
// `@workspace/api-client-react` / `@workspace/api-zod` import site is unaffected.
//
// Output is deterministic (sorted) so re-running codegen with no spec change yields a
// byte-identical barrel — keeping tsc's incremental cache warm.
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const HEADER = `/**
 * Generated barrel. Do not edit manually.
 * Re-exports every per-tag orval output file (tags-split mode).
 */
`;

/**
 * @param {string} generatedDir absolute path to a `.../src/generated` dir
 * @param {string[]} extraExports additional relative module specifiers to re-export
 */
async function writeBarrel(generatedDir, extraExports = []) {
  const entries = await fs.readdir(generatedDir, { withFileTypes: true });
  const tagDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const lines = [];
  for (const tag of tagDirs) {
    const tagFiles = (await fs.readdir(path.join(generatedDir, tag)))
      .filter((f) => f.endsWith(".ts") && f !== "index.ts")
      .sort((a, b) => a.localeCompare(b));
    for (const file of tagFiles) {
      const spec = `./${tag}/${file.replace(/\.ts$/, "")}`;
      lines.push(`export * from "${spec}";`);
    }
  }
  for (const spec of extraExports) {
    lines.push(`export * from "${spec}";`);
  }

  const content = HEADER + lines.join("\n") + "\n";
  await fs.writeFile(path.join(generatedDir, "index.ts"), content, "utf8");
  return { generatedDir, count: lines.length };
}

const results = await Promise.all([
  writeBarrel(
    path.join(root, "lib", "api-client-react", "src", "generated"),
    ["./api.schemas"],
  ),
  writeBarrel(path.join(root, "lib", "api-zod", "src", "generated")),
]);

for (const r of results) {
  console.log(`barrel: ${path.relative(root, r.generatedDir)}/index.ts (${r.count} exports)`);
}
