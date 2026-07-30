from pathlib import Path
import subprocess


def main_text(path: str) -> str:
    return subprocess.check_output(
        ["git", "show", f"origin/main:{path}"], text=True
    )


def restore(path: str) -> None:
    target = Path(path)
    target.write_text(main_text(path), encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# Rebuild existing files on their main formatting so the PR carries only
# semantic changes rather than whole-file Prettier churn.
for path in [
    "lib/db/src/schema/people.ts",
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    "artifacts/api-server/src/__tests__/people-org-soft-credit.integration.test.ts",
    "artifacts/wildflower-crm/src/pages/individual-detail.tsx",
    "artifacts/wildflower-crm/src/pages/household-detail.tsx",
    "artifacts/wildflower-crm/src/pages/funding-entity-detail.tsx",
]:
    restore(path)

# people.primary_household_id
replace_once(
    "lib/db/src/schema/people.ts",
    'import { regions } from "./regions";\n',
    'import { regions } from "./regions";\nimport { households } from "./households";\n',
    "people household import",
)
replace_once(
    "lib/db/src/schema/people.ts",
    '''  currentHomeRegionId: text("current_home_region_id").references(
    () => regions.id,
    { onDelete: "set null" },
  ),
''',
    '''  currentHomeRegionId: text("current_home_region_id").references(
    () => regions.id,
    { onDelete: "set null" },
  ),
  // One current household authority. Legacy household role rows remain during
  // the transition, but new business logic reads this direct pointer.
  primaryHouseholdId: text("primary_household_id").references(
    () => households.id,
    { onDelete: "set null" },
  ),
''',
    "people primary household field",
)
replace_once(
    "lib/db/src/schema/people.ts",
    '  index("people_current_home_region_id_idx").on(t.currentHomeRegionId),\n',
    '  index("people_current_home_region_id_idx").on(t.currentHomeRegionId),\n  index("people_primary_household_id_idx").on(t.primaryHouseholdId),\n',
    "people primary household index",
)

# Keep the transitional household-role UI synchronized with the direct pointer.
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    'import { peopleEntityRoles } from "@workspace/db/schema";\n',
    'import { people, peopleEntityRoles } from "@workspace/db/schema";\n',
    "roles people import",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''async function demoteOtherPrimaries(
  tx: Tx,
  row: typeof peopleEntityRoles.$inferSelect,
) {
''',
    '''async function syncPrimaryHousehold(
  tx: Tx,
  before: typeof peopleEntityRoles.$inferSelect | null,
  after: typeof peopleEntityRoles.$inferSelect | null,
) {
  const active =
    after?.entityType === "household" &&
    after.householdId &&
    after.current === "current"
      ? after
      : null;
  if (active) {
    await tx
      .update(peopleEntityRoles)
      .set({ current: "past", updatedAt: new Date() })
      .where(
        and(
          eq(peopleEntityRoles.personId, active.personId),
          eq(peopleEntityRoles.entityType, "household"),
          eq(peopleEntityRoles.current, "current"),
          ne(peopleEntityRoles.id, active.id),
        ),
      );
    await tx
      .update(people)
      .set({ primaryHouseholdId: active.householdId, updatedAt: new Date() })
      .where(eq(people.id, active.personId));
    return;
  }
  if (before?.householdId && before.current === "current") {
    await tx
      .update(people)
      .set({ primaryHouseholdId: null, updatedAt: new Date() })
      .where(
        and(
          eq(people.id, before.personId),
          eq(people.primaryHouseholdId, before.householdId),
        ),
      );
  }
}

async function demoteOtherPrimaries(
  tx: Tx,
  row: typeof peopleEntityRoles.$inferSelect,
) {
''',
    "roles household sync helper",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''      if (created?.primaryContact) await demoteOtherPrimaries(tx, created);
      return created;
''',
    '''      if (created?.primaryContact) await demoteOtherPrimaries(tx, created);
      if (created) await syncPrimaryHousehold(tx, null, created);
      return created;
''',
    "roles create household sync",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
''',
    '''    const row = await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(peopleEntityRoles)
        .where(eq(peopleEntityRoles.id, paramId(req)))
        .limit(1);
      const [updated] = await tx
''',
    "roles patch before row",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''      if (updated?.primaryContact) {
        await demoteOtherPrimaries(tx, updated);
      }
      return updated;
''',
    '''      if (updated?.primaryContact) {
        await demoteOtherPrimaries(tx, updated);
      }
      await syncPrimaryHousehold(tx, before ?? null, updated ?? null);
      return updated;
''',
    "roles patch household sync",
)
replace_once(
    "artifacts/api-server/src/routes/peopleEntityRoles.ts",
    '''  asyncHandler(async (req, res) => {
    await db.delete(peopleEntityRoles).where(eq(peopleEntityRoles.id, paramId(req)));
    res.status(204).end();
  }),
''',
    '''  asyncHandler(async (req, res) => {
    await db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(peopleEntityRoles)
        .where(eq(peopleEntityRoles.id, paramId(req)))
        .limit(1);
      await tx.delete(peopleEntityRoles).where(eq(peopleEntityRoles.id, paramId(req)));
      await syncPrimaryHousehold(tx, before ?? null, null);
    });
    res.status(204).end();
  }),
''',
    "roles delete household sync",
)

# Existing soft-credit regression suite needs the same Clerk middleware stub as
# the newer HTTP integration tests. No production behavior changes.
replace_once(
    "artifacts/api-server/src/__tests__/people-org-soft-credit.integration.test.ts",
    '''vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));
''',
    '''vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = { id: TEST_USER_ID, role: "admin" };
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
''',
    "soft-credit Clerk stub",
)

# Minimal record-page additions.
for path in [
    "artifacts/wildflower-crm/src/pages/individual-detail.tsx",
    "artifacts/wildflower-crm/src/pages/household-detail.tsx",
    "artifacts/wildflower-crm/src/pages/funding-entity-detail.tsx",
]:
    replace_once(
        path,
        'import { GivesThroughCard } from "@/components/gives-through-card";\n',
        'import { GivesThroughCard } from "@/components/gives-through-card";\nimport { PreferredDonorCard } from "@/components/preferred-donor-card";\n',
        f"{path} preferred donor import",
    )

replace_once(
    "artifacts/wildflower-crm/src/pages/individual-detail.tsx",
    '          <GivesThroughCard donor={{ individualGiverPersonId: person.id }} />\n',
    '          <PreferredDonorCard sourceKind="individual" sourceId={person.id} />\n\n          <GivesThroughCard donor={{ individualGiverPersonId: person.id }} />\n',
    "individual preferred donor card",
)
replace_once(
    "artifacts/wildflower-crm/src/pages/household-detail.tsx",
    '          <GivesThroughCard donor={{ householdId: household.id }} />\n',
    '          <PreferredDonorCard sourceKind="household" sourceId={household.id} />\n\n          <GivesThroughCard donor={{ householdId: household.id }} />\n',
    "household preferred donor card",
)
replace_once(
    "artifacts/wildflower-crm/src/pages/funding-entity-detail.tsx",
    '          <GivesThroughCard donor={{ organizationId: org.id }} />\n',
    '          <PreferredDonorCard sourceKind="organization" sourceId={org.id} />\n\n          <GivesThroughCard donor={{ organizationId: org.id }} />\n',
    "organization preferred donor card",
)

# Serialize all pathway writes under one transaction lock and re-run cycle
# validation after taking the lock. A per-source lock cannot prevent A->B and
# B->A from being committed concurrently.
route = "artifacts/api-server/src/routes/donorRouting.ts"
replace_once(
    route,
    '''const router: IRouter = Router();
router.use(requireAuth);

''',
    '''const router: IRouter = Router();
router.use(requireAuth);

const DONOR_ROUTING_ADVISORY_LOCK_KEY = 728411002;

''',
    "routing global lock constant",
)
replace_once(
    route,
    '''        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${donorKey(source)}))`,
        );
        const before = await getDirectDonorPreference(
''',
    '''        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${DONOR_ROUTING_ADVISORY_LOCK_KEY})`,
        );
        // Recheck after serialization. Two different sources can otherwise race
        // into a cycle even though each request passed its preflight check.
        await resolveDonorRouting(source, tx as unknown as SqlExecutor, {
          source,
          preference: proposed,
        });
        const before = await getDirectDonorPreference(
''',
    "routing serialized revalidation",
)
replace_once(
    route,
    '''    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "default_intermediary_unavailable"
      ) {
''',
    '''    } catch (error) {
      if (error instanceof DonorRoutingCycleError) {
        res.status(409).json({
          error: "donor_routing_cycle",
          message: "That change would create a circular preferred donor pathway.",
        });
        return;
      }
      if (error instanceof DonorRoutingDepthError) {
        res.status(409).json({
          error: "donor_routing_too_deep",
          message: "That preferred donor pathway is too long.",
        });
        return;
      }
      if (
        error instanceof Error &&
        error.message === "default_intermediary_unavailable"
      ) {
''',
    "routing transaction error handling",
)

# Concurrency regression: simultaneous opposite pointers cannot both commit.
test = "artifacts/api-server/src/__tests__/donor-routing.integration.test.ts"
replace_once(
    test,
    '''  it("supports an explicit ask-each-time pathway", async () => {
''',
    '''  it("serializes concurrent edits so opposite pointers cannot create a cycle", async () => {
    await put("individual", PERSON_ID, {
      mode: "self",
      targetKind: null,
      targetId: null,
      primaryHouseholdId: HOUSEHOLD_ID,
      defaultPaymentIntermediaryId: PI_ID,
    });
    await put("organization", ORG_ID, {
      mode: "self",
      targetKind: null,
      targetId: null,
      primaryHouseholdId: null,
      defaultPaymentIntermediaryId: null,
    });

    const results = await Promise.all([
      put("individual", PERSON_ID, {
        mode: "target",
        targetKind: "organization",
        targetId: ORG_ID,
        primaryHouseholdId: HOUSEHOLD_ID,
        defaultPaymentIntermediaryId: PI_ID,
      }),
      put("organization", ORG_ID, {
        mode: "target",
        targetKind: "individual",
        targetId: PERSON_ID,
        primaryHouseholdId: null,
        defaultPaymentIntermediaryId: null,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.json.error).toBe(
      "donor_routing_cycle",
    );
  });

  it("supports an explicit ask-each-time pathway", async () => {
''',
    "routing concurrency regression",
)

print("preferred donor final refinements applied")
