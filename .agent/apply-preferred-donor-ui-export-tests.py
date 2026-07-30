from pathlib import Path


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


write(
    "artifacts/wildflower-crm/src/components/preferred-donor-card.tsx",
    r'''
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDonorRoutingQueryKey,
  useGetDonorRouting,
  useUpdateDonorRouting,
  type DonorRecordKind,
  type DonorRoutingMode,
} from "@workspace/api-client-react";
import { RelatedCard, CardAction } from "@/components/record-layout";
import { DonorFieldPicker, type DonorType } from "@/components/entity-picker";
import {
  EntityCombobox,
  useHouseholdName,
  useHouseholdSearch,
  useIntermediaryName,
  useIntermediarySearch,
} from "@/components/entity-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

const MODE_LABEL: Record<DonorRoutingMode, string> = {
  self: "Use this record",
  target: "Route to another donor",
  ask: "Ask each time",
};

function donorTypeFromKind(kind: DonorRecordKind): DonorType {
  return kind === "individual" ? "individual" : kind;
}

function donorKindFromType(type: DonorType): DonorRecordKind {
  return type === "individual" ? "individual" : type;
}

export function PreferredDonorCard({
  sourceKind,
  sourceId,
}: {
  sourceKind: DonorRecordKind;
  sourceId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = getGetDonorRoutingQueryKey(sourceKind, sourceId);
  const query = useGetDonorRouting(sourceKind, sourceId, {
    query: { queryKey },
  });
  const update = useUpdateDonorRouting();
  const settings = query.data ?? null;
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<DonorRoutingMode>("self");
  const [targetType, setTargetType] = useState<DonorType>("organization");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [primaryHouseholdId, setPrimaryHouseholdId] = useState<string | null>(null);
  const [defaultIntermediaryId, setDefaultIntermediaryId] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || !settings) return;
    setMode(settings.mode);
    setTargetType(
      settings.target
        ? donorTypeFromKind(settings.target.kind)
        : sourceKind === "organization"
          ? "organization"
          : sourceKind === "household"
            ? "household"
            : "organization",
    );
    setTargetId(settings.target?.id ?? null);
    setPrimaryHouseholdId(settings.primaryHousehold?.id ?? null);
    setDefaultIntermediaryId(settings.defaultPaymentIntermediary?.id ?? null);
  }, [editing, settings, sourceKind]);

  const cancel = () => setEditing(false);

  const save = async () => {
    if (mode === "target" && !targetId) {
      toast({
        title: "Choose a preferred donor",
        description: "Select the donor record this pathway should use.",
        variant: "destructive",
      });
      return;
    }
    try {
      await update.mutateAsync({
        sourceKind,
        sourceId,
        data: {
          mode,
          targetKind: mode === "target" ? donorKindFromType(targetType) : null,
          targetId: mode === "target" ? targetId : null,
          primaryHouseholdId:
            sourceKind === "individual" ? primaryHouseholdId : null,
          defaultPaymentIntermediaryId: defaultIntermediaryId,
        },
      });
      await queryClient.invalidateQueries({ queryKey });
      setEditing(false);
      toast({ title: "Preferred donor settings saved" });
    } catch (error) {
      toast({
        title: "Could not save preferred donor settings",
        description:
          error instanceof Error ? error.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  };

  const pathwayText = !settings
    ? "Loading preferred donor settings…"
    : settings.mode === "ask"
      ? "Ask each time"
      : settings.resolved
        ? settings.resolved.id === settings.source.id &&
          settings.resolved.kind === settings.source.kind
          ? "Use this record"
          : `Use ${settings.resolved.name}`
        : "Needs a donor decision";

  return (
    <RelatedCard
      title="Preferred donor pathway"
      action={
        settings && !editing ? (
          <CardAction label="Edit" onClick={() => setEditing(true)} />
        ) : undefined
      }
    >
      {query.isLoading ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
      ) : query.isError || !settings ? (
        <p className="px-2 py-2 text-sm text-destructive">
          Preferred donor settings could not be loaded.
        </p>
      ) : editing ? (
        <div className="space-y-4 px-2 py-2">
          <div className="space-y-1.5">
            <Label>When this donor is selected</Label>
            <Select
              value={mode}
              onValueChange={(value) => setMode(value as DonorRoutingMode)}
              disabled={update.isPending}
            >
              <SelectTrigger data-testid="select-donor-routing-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MODE_LABEL) as DonorRoutingMode[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {MODE_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {mode === "target" ? (
            <div className="space-y-1.5">
              <Label>Preferred donor of record</Label>
              <DonorFieldPicker
                type={targetType}
                id={targetId}
                onChange={(nextType, nextId) => {
                  setTargetType(nextType);
                  setTargetId(nextId);
                }}
                testIdBase="preferred-donor-target"
                disabled={update.isPending}
              />
            </div>
          ) : null}

          {sourceKind === "individual" ? (
            <div className="space-y-1.5">
              <Label>Primary household</Label>
              <EntityCombobox
                useSearch={useHouseholdSearch}
                useResolve={useHouseholdName}
                value={primaryHouseholdId}
                onChange={setPrimaryHouseholdId}
                placeholder="No primary household"
                testId="select-primary-household"
                disabled={update.isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                This is the one current household used for related-giving rules.
              </p>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label>Default payment intermediary</Label>
            <EntityCombobox
              useSearch={useIntermediarySearch}
              useResolve={useIntermediaryName}
              value={defaultIntermediaryId}
              onChange={setDefaultIntermediaryId}
              placeholder="No default intermediary"
              testId="select-default-payment-intermediary"
              disabled={update.isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              For example, Vanguard Charitable or another DAF sponsor. The
              intermediary is not the donor of record.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={cancel}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={update.isPending || (mode === "target" && !targetId)}
              data-testid="button-save-preferred-donor"
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2 px-2 py-2 text-sm">
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              Donor of record
            </div>
            <div>{pathwayText}</div>
          </div>
          {settings.path.length > 1 ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Pathway
              </div>
              <div className="text-xs">
                {settings.path.map((node) => node.name).join(" → ")}
              </div>
            </div>
          ) : null}
          {sourceKind === "individual" ? (
            <div>
              <div className="text-xs font-medium text-muted-foreground">
                Primary household
              </div>
              <div>{settings.primaryHousehold?.name ?? "None"}</div>
            </div>
          ) : null}
          <div>
            <div className="text-xs font-medium text-muted-foreground">
              Default intermediary
            </div>
            <div>{settings.defaultPaymentIntermediary?.name ?? "None"}</div>
          </div>
        </div>
      )}
    </RelatedCard>
  );
}
''',
)

# Insert the card next to the existing Gives-through card on all donor pages.
replace_once(
    "artifacts/wildflower-crm/src/pages/individual-detail.tsx",
    'import { GivesThroughCard } from "@/components/gives-through-card";\n',
    'import { GivesThroughCard } from "@/components/gives-through-card";\nimport { PreferredDonorCard } from "@/components/preferred-donor-card";\n',
    "individual preferred donor import",
)
replace_once(
    "artifacts/wildflower-crm/src/pages/individual-detail.tsx",
    '''          <GivesThroughCard donor={{ individualGiverPersonId: person.id }} />
''',
    '''          <PreferredDonorCard sourceKind="individual" sourceId={person.id} />

          <GivesThroughCard donor={{ individualGiverPersonId: person.id }} />
''',
    "individual preferred donor card",
)

replace_once(
    "artifacts/wildflower-crm/src/pages/household-detail.tsx",
    'import { GivesThroughCard } from "@/components/gives-through-card";\n',
    'import { GivesThroughCard } from "@/components/gives-through-card";\nimport { PreferredDonorCard } from "@/components/preferred-donor-card";\n',
    "household preferred donor import",
)
replace_once(
    "artifacts/wildflower-crm/src/pages/household-detail.tsx",
    '''          <GivesThroughCard donor={{ householdId: household.id }} />
''',
    '''          <PreferredDonorCard sourceKind="household" sourceId={household.id} />

          <GivesThroughCard donor={{ householdId: household.id }} />
''',
    "household preferred donor card",
)

replace_once(
    "artifacts/wildflower-crm/src/pages/funding-entity-detail.tsx",
    'import { GivesThroughCard } from "@/components/gives-through-card";\n',
    'import { GivesThroughCard } from "@/components/gives-through-card";\nimport { PreferredDonorCard } from "@/components/preferred-donor-card";\n',
    "organization preferred donor import",
)
replace_once(
    "artifacts/wildflower-crm/src/pages/funding-entity-detail.tsx",
    '''          <GivesThroughCard donor={{ organizationId: org.id }} />
''',
    '''          <PreferredDonorCard sourceKind="organization" sourceId={org.id} />

          <GivesThroughCard donor={{ organizationId: org.id }} />
''',
    "organization preferred donor card",
)

# Production-safe export: names and donor/payment attribution only; no contact
# details, notes, addresses, emails, raw QBO/Stripe payloads, or credentials.
write(
    "scripts/src/export-donor-attribution.ts",
    r'''
import { createWriteStream, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import {
  db,
  donorPaymentIntermediaries,
  donorRoutingPreferences,
  giftsAndPayments,
  households,
  organizations,
  paymentIntermediaries,
  paymentUnits,
  people,
  peopleEntityRoles,
  stagedPayments,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db";
import { asc } from "drizzle-orm";

const outputPath = resolve(
  process.env.DONOR_ATTRIBUTION_EXPORT_PATH ??
    process.argv[2] ??
    `donor-attribution-${new Date().toISOString().slice(0, 10)}.json.gz`,
);

const [
  peopleRows,
  householdRows,
  organizationRows,
  roleRows,
  routeRows,
  intermediaryRows,
  donorIntermediaryRows,
  giftRows,
  unitRows,
  stagedRows,
  chargeRows,
  payoutRows,
] = await Promise.all([
  db
    .select({
      id: people.id,
      fullName: people.fullName,
      firstName: people.firstName,
      lastName: people.lastName,
      primaryHouseholdId: people.primaryHouseholdId,
      quickbooksCustomerId: people.quickbooksCustomerId,
      anonymous: people.anonymous,
      archivedAt: people.archivedAt,
    })
    .from(people)
    .orderBy(asc(people.id)),
  db
    .select({
      id: households.id,
      name: households.name,
      active: households.active,
      archivedAt: households.archivedAt,
    })
    .from(households)
    .orderBy(asc(households.id)),
  db
    .select({
      id: organizations.id,
      name: organizations.name,
      entityType: organizations.entityType,
      quickbooksCustomerId: organizations.quickbooksCustomerId,
      parentOrganizationId: organizations.parentOrganizationId,
      anonymous: organizations.anonymous,
      archivedAt: organizations.archivedAt,
    })
    .from(organizations)
    .orderBy(asc(organizations.id)),
  db
    .select({
      id: peopleEntityRoles.id,
      personId: peopleEntityRoles.personId,
      entityType: peopleEntityRoles.entityType,
      organizationId: peopleEntityRoles.organizationId,
      householdId: peopleEntityRoles.householdId,
      paymentIntermediaryId: peopleEntityRoles.paymentIntermediaryId,
      connection: peopleEntityRoles.connection,
      current: peopleEntityRoles.current,
      primaryContact: peopleEntityRoles.primaryContact,
    })
    .from(peopleEntityRoles)
    .orderBy(asc(peopleEntityRoles.id)),
  db.select().from(donorRoutingPreferences).orderBy(asc(donorRoutingPreferences.id)),
  db
    .select({
      id: paymentIntermediaries.id,
      name: paymentIntermediaries.name,
      type: paymentIntermediaries.type,
      quickbooksCustomerId: paymentIntermediaries.quickbooksCustomerId,
      archivedAt: paymentIntermediaries.archivedAt,
    })
    .from(paymentIntermediaries)
    .orderBy(asc(paymentIntermediaries.id)),
  db
    .select({
      id: donorPaymentIntermediaries.id,
      paymentIntermediaryId: donorPaymentIntermediaries.paymentIntermediaryId,
      organizationId: donorPaymentIntermediaries.organizationId,
      individualGiverPersonId:
        donorPaymentIntermediaries.individualGiverPersonId,
      householdId: donorPaymentIntermediaries.householdId,
      isDefault: donorPaymentIntermediaries.isDefault,
    })
    .from(donorPaymentIntermediaries)
    .orderBy(asc(donorPaymentIntermediaries.id)),
  db
    .select({
      id: giftsAndPayments.id,
      name: giftsAndPayments.name,
      dateReceived: giftsAndPayments.dateReceived,
      amount: giftsAndPayments.amount,
      paymentMethod: giftsAndPayments.paymentMethod,
      organizationId: giftsAndPayments.organizationId,
      individualGiverPersonId: giftsAndPayments.individualGiverPersonId,
      householdId: giftsAndPayments.householdId,
      primaryContactPersonId: giftsAndPayments.primaryContactPersonId,
      advisorPersonId: giftsAndPayments.advisorPersonId,
      paymentIntermediaryId: giftsAndPayments.paymentIntermediaryId,
      opportunityId: giftsAndPayments.opportunityId,
      archivedAt: giftsAndPayments.archivedAt,
    })
    .from(giftsAndPayments)
    .orderBy(asc(giftsAndPayments.id)),
  db
    .select({
      id: paymentUnits.id,
      kind: paymentUnits.kind,
      giftId: paymentUnits.giftId,
      sourceStagedPaymentId: paymentUnits.sourceStagedPaymentId,
      stripeChargeId: paymentUnits.stripeChargeId,
      grossAmount: paymentUnits.grossAmount,
      feeAmount: paymentUnits.feeAmount,
      netAmount: paymentUnits.netAmount,
      receivedDate: paymentUnits.receivedDate,
      lifecycle: paymentUnits.lifecycle,
    })
    .from(paymentUnits)
    .orderBy(asc(paymentUnits.id)),
  db
    .select({
      id: stagedPayments.id,
      qbEntityType: stagedPayments.qbEntityType,
      qbEntityId: stagedPayments.qbEntityId,
      payerName: stagedPayments.payerName,
      lineDescription: stagedPayments.lineDescription,
      amount: stagedPayments.amount,
      dateReceived: stagedPayments.dateReceived,
      organizationId: stagedPayments.organizationId,
      individualGiverPersonId: stagedPayments.individualGiverPersonId,
      householdId: stagedPayments.householdId,
      matchedPaymentIntermediaryId: stagedPayments.matchedPaymentIntermediaryId,
      exclusionReason: stagedPayments.exclusionReason,
    })
    .from(stagedPayments)
    .orderBy(asc(stagedPayments.id)),
  db
    .select({
      id: stripeStagedCharges.id,
      stripePayoutId: stripeStagedCharges.stripePayoutId,
      payerName: stripeStagedCharges.payerName,
      description: stripeStagedCharges.description,
      grossAmount: stripeStagedCharges.grossAmount,
      feeAmount: stripeStagedCharges.feeAmount,
      netAmount: stripeStagedCharges.netAmount,
      dateReceived: stripeStagedCharges.dateReceived,
      organizationId: stripeStagedCharges.organizationId,
      individualGiverPersonId: stripeStagedCharges.individualGiverPersonId,
      householdId: stripeStagedCharges.householdId,
      matchedPaymentIntermediaryId:
        stripeStagedCharges.matchedPaymentIntermediaryId,
      exclusionReason: stripeStagedCharges.exclusionReason,
      refunded: stripeStagedCharges.refunded,
      disputed: stripeStagedCharges.disputed,
    })
    .from(stripeStagedCharges)
    .orderBy(asc(stripeStagedCharges.id)),
  db
    .select({
      id: stripePayouts.id,
      bankDepositId: stripePayouts.bankDepositId,
      arrivalDate: stripePayouts.arrivalDate,
      amount: stripePayouts.amount,
      grossTotal: stripePayouts.grossTotal,
      feeTotal: stripePayouts.feeTotal,
      refundTotal: stripePayouts.refundTotal,
      netTotal: stripePayouts.netTotal,
      chargeCount: stripePayouts.chargeCount,
    })
    .from(stripePayouts)
    .orderBy(asc(stripePayouts.id)),
]);

const document = {
  metadata: {
    exportedAt: new Date().toISOString(),
    purpose: "donor attribution and preferred-pathway analysis",
    excludes: [
      "emails",
      "phone numbers",
      "addresses",
      "free-text notes",
      "raw QuickBooks payloads",
      "raw Stripe payloads",
      "credentials and tokens",
    ],
  },
  people: peopleRows,
  households: householdRows,
  organizations: organizationRows,
  peopleEntityRoles: roleRows,
  donorRoutingPreferences: routeRows,
  paymentIntermediaries: intermediaryRows,
  donorPaymentIntermediaries: donorIntermediaryRows,
  gifts: giftRows,
  paymentUnits: unitRows,
  stagedPayments: stagedRows,
  stripeCharges: chargeRows,
  stripePayouts: payoutRows,
};

await pipeline(
  Readable.from([JSON.stringify(document)]),
  createGzip({ level: 9 }),
  createWriteStream(outputPath, { mode: 0o600 }),
);
chmodSync(outputPath, 0o600);
console.log(outputPath);
''',
)

replace_once(
    "scripts/package.json",
    '    "audit:reconciliation": "tsx ./src/audit-reconciliation.ts",\n',
    '    "audit:reconciliation": "tsx ./src/audit-reconciliation.ts",\n    "export:donor-attribution": "tsx ./src/export-donor-attribution.ts",\n',
    "export script package command",
)

write(
    "docs/donor-attribution-export.md",
    r'''
# Donor attribution production export

This export is for reviewing preferred donor pathways, household groupings, DAF
usage, and inconsistent donor attribution against production-shaped data.

It deliberately excludes contact information, free-text notes, raw source
payloads, and credentials. The resulting compressed JSON still contains donor
names and financial amounts, so treat it as confidential.

Run from the repository root with a read-only production database credential:

```bash
DATABASE_URL="$PROD_READ_ONLY_DATABASE_URL" \
DONOR_ATTRIBUTION_EXPORT_PATH="./donor-attribution-production.json.gz" \
pnpm --filter @workspace/scripts run export:donor-attribution
```

The file is written with mode `0600`. Upload only the resulting `.json.gz` file
to the private analysis conversation. Delete the local copy when the review is
complete.
''',
)

write(
    "artifacts/api-server/src/__tests__/donor-routing.integration.test.ts",
    r'''
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";

const RAW_DB_URL = process.env.DATABASE_URL;
const HAS_DB =
  !!RAW_DB_URL && !/test:test@localhost:5432\/test/.test(RAW_DB_URL);
const RUN = `donorroute_${Date.now()}`;
const USER_ID = `${RUN}_user`;
const PERSON_ID = `${RUN}_person`;
const ORG_ID = `${RUN}_org`;
const HOUSEHOLD_ID = `${RUN}_household`;
const PI_ID = `${RUN}_pi`;

const auth = vi.hoisted(() => ({
  current: { id: "", role: "admin" } as { id: string; role: string },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: { id: string; role: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.appUser = auth.current;
    next();
  },
}));
vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

let db: (typeof import("@workspace/db"))["db"];
let schema: typeof import("@workspace/db");
let server: Server;
let baseUrl = "";

async function get(kind: string, id: string) {
  const response = await fetch(`${baseUrl}/api/donor-routing/${kind}/${id}`);
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

async function put(
  kind: string,
  id: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}/api/donor-routing/${kind}/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  db = schema.db;
  auth.current = { id: USER_ID, role: "admin" };
  await db.insert(schema.users).values({
    id: USER_ID,
    clerkId: `clerk_${USER_ID}`,
    email: `${USER_ID}@wildflowerschools.org`,
    role: "admin",
  });
  await db.insert(schema.people).values({
    id: PERSON_ID,
    firstName: "Arthur",
    lastName: "Rock",
    fullName: "Arthur Rock",
  });
  await db.insert(schema.organizations).values({
    id: ORG_ID,
    name: "Arthur Rock & Company",
  });
  await db.insert(schema.households).values({
    id: HOUSEHOLD_ID,
    name: "Rock Household",
  });
  await db.insert(schema.paymentIntermediaries).values({
    id: PI_ID,
    name: "Vanguard Charitable",
    type: "daf",
  });

  const { default: app } = await import("../app");
  server = await new Promise<Server>((resolveServer) => {
    const instance = app.listen(0, () => resolveServer(instance));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  await db
    .delete(schema.auditLog)
    .where(inArray(schema.auditLog.entityId, [PERSON_ID, ORG_ID]));
  await db
    .delete(schema.donorRoutingPreferences)
    .where(
      inArray(schema.donorRoutingPreferences.sourceKind, [
        "individual",
        "organization",
      ]),
    );
  await db
    .delete(schema.donorPaymentIntermediaries)
    .where(eq(schema.donorPaymentIntermediaries.paymentIntermediaryId, PI_ID));
  await db
    .delete(schema.peopleEntityRoles)
    .where(eq(schema.peopleEntityRoles.personId, PERSON_ID));
  await db.delete(schema.people).where(eq(schema.people.id, PERSON_ID));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, ORG_ID));
  await db
    .delete(schema.households)
    .where(eq(schema.households.id, HOUSEHOLD_ID));
  await db
    .delete(schema.paymentIntermediaries)
    .where(eq(schema.paymentIntermediaries.id, PI_ID));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
}, 60_000);

describe.skipIf(!HAS_DB)("preferred donor pathways", () => {
  it("defaults every donor record to itself", async () => {
    const { status, json } = await get("individual", PERSON_ID);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      mode: "self",
      requiresDecision: false,
      source: { kind: "individual", id: PERSON_ID, name: "Arthur Rock" },
      resolved: { kind: "individual", id: PERSON_ID, name: "Arthur Rock" },
      path: [{ kind: "individual", id: PERSON_ID, name: "Arthur Rock" }],
      primaryHousehold: null,
      defaultPaymentIntermediary: null,
    });
  });

  it("routes Arthur to his company and saves household and DAF defaults", async () => {
    const { status, json } = await put("individual", PERSON_ID, {
      mode: "target",
      targetKind: "organization",
      targetId: ORG_ID,
      primaryHouseholdId: HOUSEHOLD_ID,
      defaultPaymentIntermediaryId: PI_ID,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      mode: "target",
      target: { kind: "organization", id: ORG_ID },
      resolved: { kind: "organization", id: ORG_ID },
      path: [
        { kind: "individual", id: PERSON_ID },
        { kind: "organization", id: ORG_ID },
      ],
      primaryHousehold: { id: HOUSEHOLD_ID, name: "Rock Household" },
      defaultPaymentIntermediary: {
        id: PI_ID,
        name: "Vanguard Charitable",
        type: "daf",
      },
    });

    const [person] = await db
      .select({ primaryHouseholdId: schema.people.primaryHouseholdId })
      .from(schema.people)
      .where(eq(schema.people.id, PERSON_ID));
    expect(person.primaryHouseholdId).toBe(HOUSEHOLD_ID);

    const roles = await db
      .select()
      .from(schema.peopleEntityRoles)
      .where(eq(schema.peopleEntityRoles.personId, PERSON_ID));
    expect(roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          householdId: HOUSEHOLD_ID,
          current: "current",
        }),
      ]),
    );

    const [defaultPi] = await db
      .select()
      .from(schema.donorPaymentIntermediaries)
      .where(eq(schema.donorPaymentIntermediaries.paymentIntermediaryId, PI_ID));
    expect(defaultPi).toMatchObject({
      individualGiverPersonId: PERSON_ID,
      isDefault: true,
    });
  });

  it("rejects a pathway cycle without changing the organization", async () => {
    const { status, json } = await put("organization", ORG_ID, {
      mode: "target",
      targetKind: "individual",
      targetId: PERSON_ID,
      primaryHouseholdId: null,
      defaultPaymentIntermediaryId: null,
    });
    expect(status).toBe(409);
    expect(json.error).toBe("donor_routing_cycle");

    const org = await get("organization", ORG_ID);
    expect(org.status).toBe(200);
    expect(org.json).toMatchObject({
      mode: "self",
      resolved: { kind: "organization", id: ORG_ID },
    });
  });

  it("supports an explicit ask-each-time pathway", async () => {
    const { status, json } = await put("individual", PERSON_ID, {
      mode: "ask",
      targetKind: null,
      targetId: null,
      primaryHouseholdId: HOUSEHOLD_ID,
      defaultPaymentIntermediaryId: PI_ID,
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      mode: "ask",
      resolved: null,
      requiresDecision: true,
      path: [{ kind: "individual", id: PERSON_ID }],
    });
  });
});
''',
)

print("preferred donor UI, export, and tests patch applied")
