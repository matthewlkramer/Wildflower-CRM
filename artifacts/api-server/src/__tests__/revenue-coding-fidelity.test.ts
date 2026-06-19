import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  REVENUE_ACCOUNTS,
  SEED_ENTITY_CODING_RULES,
} from "@workspace/api-zod";

/**
 * Fidelity guard: the in-code seed constants (REVENUE_ACCOUNTS,
 * SEED_ENTITY_CODING_RULES) must reproduce exactly what migration 0050 seeds
 * into the `revenue_accounts` and `entity_coding_rules` tables. The derivation
 * lib reads the code constants; the DB reads the migration. If the two drift,
 * derived coding silently disagrees with what the database serves — so this
 * test parses the migration SQL and asserts both seed sets match.
 *
 * Mirrors `quickbooks-rules-fidelity.test.ts` (code SEED ↔ runtime source).
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(
  here,
  "../../../../lib/db/migrations/0050_revenue_coding_capture.sql",
);

function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

describe("revenue_accounts seed fidelity (code ↔ migration 0050)", () => {
  const sql = migrationSql();

  for (const acct of REVENUE_ACCOUNTS) {
    it(`migration seeds ${acct.code} (${acct.name})`, () => {
      const payer = acct.payerType == null ? "NULL" : `'${acct.payerType}'`;
      // ('4000.1', 'Unrestricted Donations - Individual', 'unrestricted', 'individual', 10, true)
      const row = new RegExp(
        `\\('${escapeRe(acct.code)}',\\s*` +
          `'${escapeRe(acct.name)}',\\s*` +
          `'${escapeRe(acct.kind)}',\\s*` +
          `${payer},\\s*` +
          `${acct.sortOrder},\\s*` +
          `true\\)`,
      );
      expect(row.test(sql)).toBe(true);
    });
  }

  it("migration seeds no codes beyond the code constant", () => {
    const codes = new Set(REVENUE_ACCOUNTS.map((a) => a.code));
    const insertBlock = sliceBlock(
      sql,
      "INSERT INTO revenue_accounts",
      "ON CONFLICT (code)",
    );
    const seeded = [...insertBlock.matchAll(/\('([0-9.]+)',/g)].map((m) => m[1]);
    expect(seeded.length).toBeGreaterThan(0);
    for (const code of seeded) {
      expect(codes.has(code)).toBe(true);
    }
    expect(seeded.length).toBe(codes.size);
  });
});

describe("entity_coding_rules seed fidelity (code ↔ migration 0050)", () => {
  const sql = migrationSql();
  const block = sliceBlock(
    sql,
    "INSERT INTO entity_coding_rules",
    "ON CONFLICT (entity_id)",
  );

  for (const rule of SEED_ENTITY_CODING_RULES) {
    it(`migration seeds rule for ${rule.entityId}`, () => {
      const loc = rule.location == null ? "NULL" : `'${escapeRe(rule.location)}'`;
      // The migration tags NULL columns with ::text — accept an optional cast.
      const cls =
        rule.revenueClass == null
          ? "NULL(?:::text)?"
          : `'${escapeRe(rule.revenueClass)}'(?:::text)?`;
      const row = new RegExp(
        `\\('${escapeRe(rule.entityId)}',\\s*` +
          `${rule.forceRestricted},\\s*` +
          `${loc},\\s*` +
          `${cls},\\s*` +
          `${rule.enabled},`,
      );
      expect(row.test(block)).toBe(true);
    });
  }

  it("migration seeds no entities beyond the code constant", () => {
    const ids = new Set(SEED_ENTITY_CODING_RULES.map((r) => r.entityId));
    const seeded = [...block.matchAll(/\('([a-z_]+)',\s*(?:true|false),/g)].map(
      (m) => m[1],
    );
    expect(seeded.length).toBeGreaterThan(0);
    for (const id of seeded) {
      expect(ids.has(id)).toBe(true);
    }
    expect(seeded.length).toBe(ids.size);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sliceBlock(sql: string, startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}
