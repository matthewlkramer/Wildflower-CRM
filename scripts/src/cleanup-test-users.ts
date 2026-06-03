import { pool } from "@workspace/db";

const result = await pool.query<{ id: string; email: string }>(
  `UPDATE users
   SET archived_at = now(), updated_at = now()
   WHERE first_name ILIKE 'Test'
     AND last_name = ANY($1::text[])
     AND archived_at IS NULL
   RETURNING id, email`,
  [["Dev", "Admin"]],
);

if (result.rowCount === 0) {
  console.log("No test users to archive.");
} else {
  console.log(`Archived ${result.rowCount} test user(s):`);
  for (const u of result.rows) {
    console.log(`  ${u.email} (${u.id})`);
  }
}

await pool.end();
