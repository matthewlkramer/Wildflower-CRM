// Vitest global setup: provision and target a dedicated test database.
//
// Why: the suite used to run against the live dev database while the dev API
// server's schedulers churned on it — a flake source (interference, pollution
// of dev data, schema drift unrelated to the change under test) and a
// contention tax that grows with test parallelism. Instead we run every test
// against `<devdb>_test` on the same Postgres instance.
//
// How: this runs ONCE in the vitest main process, before any worker forks.
// 1. Derive the test DB name from DATABASE_URL (`<name>_test`).
// 2. Under a Postgres advisory lock (so concurrent vitest invocations — e.g.
//    the platform running `test-api` and `test-api-changed` checks at the same
//    time — don't race), create the DB if missing. When the schema files'
//    content hash differs from the stamp stored in the test DB, DROP and
//    recreate the `public` schema, then `drizzle-kit push --force` into it.
//    Pushing into an EMPTY schema is pure CREATE and never hits drizzle-kit's
//    interactive "create or rename?" prompt (which, without a TTY, exits 0
//    while applying NOTHING — see the post-merge-push-abort memory).
//    The stamp lives in a separate `test_meta` schema so drizzle-kit's
//    introspection of `public` never sees an unknown table.
//    Unchanged schema hash = no push, setup costs ~1s.
// 3. Point process.env.DATABASE_URL at the test DB. Forked workers inherit
//    the mutated env, so `@workspace/db`'s pool, every in-process HTTP server,
//    and every test-local Pool all connect to the test DB with no per-file
//    changes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const ADVISORY_LOCK_KEY = 727_501; // arbitrary app-unique key for test-DB setup

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const dbPackageDir = path.join(repoRoot, "lib", "db");
const schemaDir = path.join(dbPackageDir, "src", "schema");

// Extensions the dev DB relies on (drizzle push creates indexes that need
// them but never creates extensions itself — see publish-flow notes).
const REQUIRED_EXTENSIONS = ["pg_trgm"];

// Small, stable reference tables some tests key real FKs against (e.g.
// allocations pointing at entities like `wildflower_foundation`). Mirrored
// from the dev DB right after each schema push. Order matters only if these
// ever grow FKs to each other (today they don't).
const REFERENCE_TABLES = ["entities", "regions", "fiscal_years"];

function schemaHash(): string {
  const hash = createHash("sha256");
  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".ts"))
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(schemaDir, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      "DATABASE_URL must be set so the test database can be provisioned from it.",
    );
  }

  const devUrl = new URL(rawUrl);
  const devDbName = devUrl.pathname.replace(/^\//, "");
  if (devDbName.endsWith("_test")) {
    // Already pointed at a test DB (e.g. re-entrant run) — nothing to do.
    return;
  }
  const testDbName = `${devDbName}_test`;
  const testUrl = new URL(rawUrl);
  testUrl.pathname = `/${testDbName}`;

  const admin = new Client({ connectionString: rawUrl });
  await admin.connect();
  let holdLock = false;
  try {
    // Serialize concurrent vitest invocations across processes. The lock is
    // held for the ENTIRE run (released in the returned teardown), because two
    // suites sharing one test DB interfere: far-future (2099-band) seeds from
    // one run crowd the other's date-proximity LIMIT'd searches. If the
    // process is killed, Postgres releases the lock with the session.
    await admin.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    const exists = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [testDbName],
    );
    if (exists.rowCount === 0) {
      // Identifier built from the trusted dev DB name; quote defensively.
      await admin.query(`CREATE DATABASE "${testDbName.replace(/"/g, '""')}"`);
      console.log(`[test-db] created database ${testDbName}`);
    }

    const wantHash = schemaHash();
    const test = new Client({ connectionString: testUrl.toString() });
    await test.connect();
    try {
      await test.query("CREATE SCHEMA IF NOT EXISTS test_meta");
      await test.query(
        `CREATE TABLE IF NOT EXISTS test_meta.schema_stamp (
           id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
           hash text NOT NULL,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const stamped = await test.query(
        "SELECT hash FROM test_meta.schema_stamp WHERE id = 1",
      );
      if (stamped.rows[0]?.hash !== wantHash) {
        console.log(
          "[test-db] schema changed — recreating public schema + drizzle-kit push",
        );
        await test.query("DROP SCHEMA public CASCADE");
        await test.query("CREATE SCHEMA public");
        for (const ext of REQUIRED_EXTENSIONS) {
          await test.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
        }
        execFileSync(
          "pnpm",
          ["exec", "drizzle-kit", "push", "--force", "--config", "./drizzle.config.ts"],
          {
            cwd: dbPackageDir,
            stdio: "inherit",
            env: { ...process.env, DATABASE_URL: testUrl.toString() },
          },
        );
        // Sanity-check the push actually created tables — drizzle-kit can
        // exit 0 without applying anything if it hits an interactive prompt.
        const created = await test.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
        );
        if ((created.rows[0]?.n ?? 0) < 10) {
          throw new Error(
            `[test-db] drizzle-kit push produced only ${created.rows[0]?.n} tables — push did not apply. Refusing to stamp.`,
          );
        }
        await test.query(
          `INSERT INTO test_meta.schema_stamp (id, hash) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, updated_at = now()`,
          [wantHash],
        );
      } else {
        // Warm path: start every run from a clean slate. Leftovers from
        // killed runs otherwise accumulate (far-future reconciliation seeds,
        // reused phone constants, …) and crowd LIMIT'd searches — the exact
        // flake class the dedicated DB exists to eliminate. Safe because the
        // whole run holds the advisory lock, so no other vitest invocation
        // is mid-execution.
        const tables = await test.query(
          `SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename <> ALL($1)`,
          [REFERENCE_TABLES],
        );
        if (tables.rows.length > 0) {
          const list = tables.rows
            .map((r: { tablename: string }) => `"${r.tablename.replace(/"/g, '""')}"`)
            .join(", ");
          await test.query(`TRUNCATE TABLE ${list} CASCADE`);
          console.log(`[test-db] truncated ${tables.rows.length} tables`);
        }
      }

      // Mirror stable reference rows from the dev DB (tests reference real
      // entity/region/fiscal-year ids; everything else is test-seeded).
      // Runs every setup so newly added dev reference rows top up over time.
      for (const table of REFERENCE_TABLES) {
        const src = await admin.query(
          `SELECT coalesce(json_agg(t), '[]'::json) AS rows FROM "${table}" t`,
        );
        const rows = JSON.stringify(src.rows[0]?.rows ?? []);
        const res = await test.query(
          `INSERT INTO "${table}"
           SELECT * FROM json_populate_recordset(null::"${table}", $1::json)
           ON CONFLICT DO NOTHING`,
          [rows],
        );
        if ((res.rowCount ?? 0) > 0) {
          console.log(`[test-db] mirrored ${res.rowCount} rows into ${table}`);
        }
      }
    } finally {
      await test.end();
    }
    holdLock = true;
  } finally {
    if (!holdLock) {
      await admin
        .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
        .catch(() => {});
      await admin.end();
    }
  }

  // Forked workers inherit this; everything downstream connects to the test DB.
  process.env.DATABASE_URL = testUrl.toString();
  console.log(`[test-db] tests will run against ${testDbName}`);

  // Teardown: release the run-long serialization lock. If the process dies,
  // the session close releases it anyway.
  return async () => {
    await admin
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
      .catch(() => {});
    await admin.end().catch(() => {});
  };
}
