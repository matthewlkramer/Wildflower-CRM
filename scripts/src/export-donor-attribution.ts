import { createWriteStream, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import {
  db,
  pool,
  donorPaymentIntermediaries,
  donorRoutingPreferences,
  giftsAndPayments,
  households,
  organizations,
  paymentIntermediaries,
  paymentUnits,
  peopleEntityRoles,
  stagedPayments,
  stripePayouts,
  stripeStagedCharges,
} from "@workspace/db";

const outputPath = resolve(
  process.env.DONOR_ATTRIBUTION_EXPORT_PATH ??
    process.argv[2] ??
    `donor-attribution-${new Date().toISOString().slice(0, 10)}.json.gz`,
);

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1
         AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return result.rows[0]?.exists === true;
}

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [table],
  );
  return result.rows[0]?.exists === true;
}

async function loadPeople() {
  const hasPrimaryHousehold = await columnExists(
    "people",
    "primary_household_id",
  );
  const result = await pool.query<{
    id: string;
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    primaryHouseholdId: string | null;
    quickbooksCustomerId: string | null;
    anonymous: boolean;
    archivedAt: Date | null;
  }>(`
    SELECT id,
           full_name AS "fullName",
           first_name AS "firstName",
           last_name AS "lastName",
           ${hasPrimaryHousehold ? "primary_household_id" : "NULL::text"} AS "primaryHouseholdId",
           quickbooks_customer_id AS "quickbooksCustomerId",
           anonymous,
           archived_at AS "archivedAt"
    FROM people
  `);
  return result.rows;
}

async function loadRoutingPreferences() {
  return (await tableExists("donor_routing_preferences"))
    ? db.select().from(donorRoutingPreferences)
    : [];
}

async function loadDonorIntermediaries() {
  const hasDefault = await columnExists(
    "donor_payment_intermediaries",
    "is_default",
  );
  if (hasDefault) {
    return db
      .select({
        id: donorPaymentIntermediaries.id,
        paymentIntermediaryId:
          donorPaymentIntermediaries.paymentIntermediaryId,
        organizationId: donorPaymentIntermediaries.organizationId,
        individualGiverPersonId:
          donorPaymentIntermediaries.individualGiverPersonId,
        householdId: donorPaymentIntermediaries.householdId,
        isDefault: donorPaymentIntermediaries.isDefault,
      })
      .from(donorPaymentIntermediaries);
  }
  const rows = await db
    .select({
      id: donorPaymentIntermediaries.id,
      paymentIntermediaryId: donorPaymentIntermediaries.paymentIntermediaryId,
      organizationId: donorPaymentIntermediaries.organizationId,
      individualGiverPersonId:
        donorPaymentIntermediaries.individualGiverPersonId,
      householdId: donorPaymentIntermediaries.householdId,
    })
    .from(donorPaymentIntermediaries);
  return rows.map((row) => ({ ...row, isDefault: false }));
}

try {
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
    loadPeople(),
    db
      .select({
        id: households.id,
        name: households.name,
        active: households.active,
        archivedAt: households.archivedAt,
      })
      .from(households),
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
      .from(organizations),
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
      .from(peopleEntityRoles),
    loadRoutingPreferences(),
    db
      .select({
        id: paymentIntermediaries.id,
        name: paymentIntermediaries.name,
        type: paymentIntermediaries.type,
        quickbooksCustomerId: paymentIntermediaries.quickbooksCustomerId,
        archivedAt: paymentIntermediaries.archivedAt,
      })
      .from(paymentIntermediaries),
    loadDonorIntermediaries(),
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
      .from(giftsAndPayments),
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
      .from(paymentUnits),
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
        matchedPaymentIntermediaryId:
          stagedPayments.matchedPaymentIntermediaryId,
        exclusionReason: stagedPayments.exclusionReason,
      })
      .from(stagedPayments),
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
        individualGiverPersonId:
          stripeStagedCharges.individualGiverPersonId,
        householdId: stripeStagedCharges.householdId,
        matchedPaymentIntermediaryId:
          stripeStagedCharges.matchedPaymentIntermediaryId,
        exclusionReason: stripeStagedCharges.exclusionReason,
        refunded: stripeStagedCharges.refunded,
        disputed: stripeStagedCharges.disputed,
      })
      .from(stripeStagedCharges),
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
      .from(stripePayouts),
  ]);

  const document = {
    metadata: {
      exportedAt: new Date().toISOString(),
      purpose: "donor attribution and preferred-pathway analysis",
      pathwaySchemaPresent: routeRows.length > 0 ||
        (await tableExists("donor_routing_preferences")),
      excludes: [
        "emails",
        "phone numbers",
        "addresses",
        "relationship and record notes",
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
} finally {
  await pool.end();
}
