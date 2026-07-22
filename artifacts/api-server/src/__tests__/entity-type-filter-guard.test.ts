import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { entityTypeEnum } from "@workspace/db/schema";
import { CreateOrganizationBody } from "@workspace/api-zod";

/**
 * Guard: the Organizations list Type filter options can never fall behind the
 * canonical entity-type list.
 *
 * The chain is: DB enum (`entity_type` in lib/db/src/schema/_enums.ts) →
 * OpenAPI contract → generated zod schemas (@workspace/api-zod) + generated
 * client enum (`EntityType` in lib/api-client-react), and the frontend
 * derives its Type filter options directly from that generated EntityType
 * object (`SUBTYPES = Object.values(EntityType)` in funding-entities.tsx).
 *
 * So the two generated artifacts are the only places drift can occur:
 *  (a) the generated zod enum on CreateOrganizationBody.entityType, and
 *  (b) the generated client EntityType const the UI reads.
 * Both must equal the DB enum exactly. If this fails, regenerate via
 * `pnpm --filter @workspace/api-spec run codegen` after fixing openapi.yaml.
 */

// Unwrap .nullish()/.optional()/.nullable() wrappers down to the inner enum.
function zodEnumOptions(schema: unknown): string[] {
  let s = schema as { _def?: { innerType?: unknown; values?: string[] } } & {
    options?: string[];
  };
  while (s?._def && "innerType" in s._def && s._def.innerType) {
    s = s._def.innerType as typeof s;
  }
  const options = s.options ?? s._def?.values;
  if (!options) throw new Error("could not resolve zod enum options");
  return [...options];
}

const canonical = [...entityTypeEnum.enumValues].sort();

describe("entity-type filter completeness", () => {
  it("generated zod entityType enum matches the DB enum exactly", () => {
    const shape = (
      CreateOrganizationBody as unknown as {
        shape: Record<string, unknown>;
      }
    ).shape;
    expect(shape.entityType, "CreateOrganizationBody.entityType missing").toBeDefined();
    expect(zodEnumOptions(shape.entityType).sort()).toEqual(canonical);
  });

  it("generated client EntityType (the UI's Type filter source) matches the DB enum exactly", () => {
    // Source-scan the generated client schema file rather than importing the
    // react client package into the API server's dependency graph.
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../lib/api-client-react/src/generated/api.schemas.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const start = source.indexOf("export const EntityType = {");
    expect(start, "EntityType const not found in generated client").toBeGreaterThan(-1);
    const end = source.indexOf("}", start);
    const block = source.slice(start, end);
    const values = [...block.matchAll(/:\s*'([a-z_0-9]+)'/g)].map((m) => m[1]);
    expect([...new Set(values)].sort()).toEqual(canonical);
  });
});
