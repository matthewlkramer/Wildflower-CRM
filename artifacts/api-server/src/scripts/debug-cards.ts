import { readFileSync, writeFileSync } from "node:fs";

// Read the handler-dumped {sql, params} (debug-cards-full.json), inline params,
// and write a runnable .sql for read-only EXPLAIN/execution against a DB.
function main() {
  const { sql, params } = JSON.parse(
    readFileSync(
      "/home/runner/workspace/artifacts/api-server/debug-cards-full.json",
      "utf8",
    ),
  ) as { sql: string; params: unknown[] };
  let out = sql;
  const indexed = params.map((p, i) => ({ i: i + 1, p }));
  indexed.sort((a, b) => b.i - a.i);
  for (const { i, p } of indexed) {
    const lit =
      p === null || p === undefined
        ? "NULL"
        : typeof p === "number"
          ? String(p)
          : typeof p === "boolean"
            ? p
              ? "TRUE"
              : "FALSE"
            : `'${String(p).replace(/'/g, "''")}'`;
    out = out.split(`$${i}`).join(lit);
  }
  writeFileSync(
    "/home/runner/workspace/artifacts/api-server/debug-cards-full.sql",
    out,
  );
  console.log("wrote debug-cards-full.sql len=", out.length, "nparams=", params.length);
}
main();
