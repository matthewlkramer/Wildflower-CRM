import {
  emails as emailsTable,
  funders,
  organizations,
  opportunitiesAndPledges,
  paymentIntermediaries,
  people,
  peopleEntityRoles,
  phoneNumbers,
  pledgeAllocations,
  households,
} from "@workspace/db/schema";
import { and, eq, ilike, sql } from "drizzle-orm";
import { newId } from "./helpers";
import type { ProposedAction } from "./proposeActions";

/**
 * Dispatcher for AI-proposed actions on email-intelligence proposals.
 *
 * Each accept handler in `routes/emailProposals.ts` opens a single
 * transaction, claims the proposal row, and then walks the action
 * list through `applyAction(tx, action, ctx)` here. Per-action errors
 * abort the transaction so a half-applied set never lands — the user
 * gets a 4xx/5xx and the proposal stays pending.
 *
 * IDs in actions are re-validated at apply time (entities may have
 * been deleted between proposal-creation and accept) so a stale plan
 * fails loudly with a recognizable error rather than dangling FK
 * references.
 *
 * All inserts are explicit — no upserts. Duplicates (e.g. trying to
 * add an email that already exists for the person) are silently
 * skipped with an explanatory `result.skipped` entry so the user can
 * see what didn't get applied and why.
 */

export interface ApplyActionResult {
  type: ProposedAction["type"];
  status: "applied" | "skipped" | "failed";
  message?: string;
  createdId?: string;
}

/**
 * Defensive validator for a single action coming off email_proposals.
 * The Claude tool schema enforces this shape at AI time, but the
 * action set is then stored as untyped jsonb and could in principle
 * be tampered with (DB superuser, future bulk-edit tools, schema
 * drift). Validate again at dispatch time before letting it touch
 * the DB — return a structured `failed` result instead of throwing
 * so the accept handler reports the bad action cleanly.
 */
export function validateAction(raw: unknown): { ok: true; action: ProposedAction } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") return { ok: false, message: "Action is not an object." };
  const a = raw as Record<string, unknown>;
  const t = a.type;
  if (typeof t !== "string") return { ok: false, message: "Action missing 'type'." };
  if (typeof a.reason !== "string") return { ok: false, message: `Action ${t} missing 'reason'.` };
  const stringField = (k: string) => typeof a[k] === "string" && (a[k] as string).length > 0;
  const optString = (k: string) => a[k] === undefined || typeof a[k] === "string";
  const optNumber = (k: string) => a[k] === undefined || typeof a[k] === "number";
  const optBool = (k: string) => a[k] === undefined || typeof a[k] === "boolean";
  switch (t) {
    case "deactivate_per":
      if (!stringField("perId")) return { ok: false, message: "deactivate_per needs perId." };
      break;
    case "create_per":
      if (!stringField("personId")) return { ok: false, message: "create_per needs personId." };
      if (!optString("funderId") || !optString("organizationId") || !optString("paymentIntermediaryId") || !optString("householdId") || !optString("connection") || !optString("externalTitleOrRole")) {
        return { ok: false, message: "create_per has invalid field type." };
      }
      break;
    case "create_person_with_per":
      if (!stringField("firstName") || !stringField("lastName")) {
        return { ok: false, message: "create_person_with_per needs firstName + lastName." };
      }
      if (!optString("emailAddress") || !optString("funderId") || !optString("organizationId") || !optString("connection") || !optString("externalTitleOrRole")) {
        return { ok: false, message: "create_person_with_per has invalid field type." };
      }
      break;
    case "create_org_with_per":
      if (!stringField("personId") || !stringField("organizationName")) {
        return { ok: false, message: "create_org_with_per needs personId + organizationName." };
      }
      if (!optString("organizationType") || !optString("emailDomain") || !optString("connection") || !optString("externalTitleOrRole")) {
        return { ok: false, message: "create_org_with_per has invalid field type." };
      }
      break;
    case "create_funder_with_per":
      if (!stringField("personId") || !stringField("funderName")) {
        return { ok: false, message: "create_funder_with_per needs personId + funderName." };
      }
      if (!optString("emailDomain") || !optString("connection") || !optString("externalTitleOrRole")) {
        return { ok: false, message: "create_funder_with_per has invalid field type." };
      }
      break;
    case "add_email":
      if (!stringField("personId") || !stringField("emailAddress")) {
        return { ok: false, message: "add_email needs personId + emailAddress." };
      }
      if (!optString("emailType") || !optBool("setPrimary")) {
        return { ok: false, message: "add_email has invalid field type." };
      }
      break;
    case "set_primary_email":
      if (!optString("emailId") || !optString("personId") || !optString("emailAddress")) {
        return { ok: false, message: "set_primary_email has invalid field type." };
      }
      if (!a.emailId && !(a.personId && a.emailAddress)) {
        return { ok: false, message: "set_primary_email needs emailId or (personId + emailAddress)." };
      }
      break;
    case "mark_email_invalid":
      if (!stringField("emailAddress")) return { ok: false, message: "mark_email_invalid needs emailAddress." };
      break;
    case "create_grant_opportunity":
      if (!stringField("title")) return { ok: false, message: "create_grant_opportunity needs title." };
      if (!optString("funderId") || !optString("funderName") || !optNumber("askAmount") || !optString("deadline") || !optString("stage")) {
        return { ok: false, message: "create_grant_opportunity has invalid field type." };
      }
      break;
    case "set_phone":
      if (!stringField("personId") || !stringField("phoneNumber")) {
        return { ok: false, message: "set_phone needs personId + phoneNumber." };
      }
      if (!optString("phoneType") || !optBool("setPrimary")) {
        return { ok: false, message: "set_phone has invalid field type." };
      }
      break;
    case "update_per_title":
      if (!stringField("perId") || !stringField("externalTitleOrRole")) {
        return { ok: false, message: "update_per_title needs perId + externalTitleOrRole." };
      }
      break;
    default:
      return { ok: false, message: `Unknown action type "${t}".` };
  }
  return { ok: true, action: a as unknown as ProposedAction };
}

// We type the tx as `any` here because Drizzle's transaction generic
// is parameterized over the schema and threading that through every
// call site adds noise without value. The runtime is the same db
// object so all methods are present.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export async function applyAction(
  tx: Tx,
  action: ProposedAction,
  ctx: { mailboxUserId: string },
): Promise<ApplyActionResult> {
  try {
    switch (action.type) {
      case "deactivate_per":
        return await applyDeactivatePer(tx, action);
      case "create_per":
        return await applyCreatePer(tx, action);
      case "create_person_with_per":
        return await applyCreatePersonWithPer(tx, action, ctx);
      case "create_org_with_per":
        return await applyCreateOrgWithPer(tx, action, ctx);
      case "create_funder_with_per":
        return await applyCreateFunderWithPer(tx, action, ctx);
      case "add_email":
        return await applyAddEmail(tx, action);
      case "set_primary_email":
        return await applySetPrimaryEmail(tx, action);
      case "mark_email_invalid":
        return await applyMarkEmailInvalid(tx, action);
      case "create_grant_opportunity":
        return await applyCreateGrantOpportunity(tx, action, ctx);
      case "set_phone":
        return await applySetPhone(tx, action);
      case "update_per_title":
        return await applyUpdatePerTitle(tx, action);
    }
  } catch (err) {
    return {
      type: action.type,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ──────────────────────────────────────────────────────────────────

async function applyDeactivatePer(
  tx: Tx,
  a: Extract<ProposedAction, { type: "deactivate_per" }>,
): Promise<ApplyActionResult> {
  const rows = await tx
    .update(peopleEntityRoles)
    .set({ current: "past", updatedAt: new Date() })
    .where(
      and(
        eq(peopleEntityRoles.id, a.perId),
        eq(peopleEntityRoles.current, "current"),
      ),
    )
    .returning({ id: peopleEntityRoles.id });
  if (rows.length === 0) {
    return {
      type: a.type,
      status: "skipped",
      message: `Role ${a.perId} not found or already past.`,
    };
  }
  return { type: a.type, status: "applied" };
}

async function applyCreatePer(
  tx: Tx,
  a: Extract<ProposedAction, { type: "create_per" }>,
): Promise<ApplyActionResult> {
  // Resolve entity_type from whichever FK is set; reject if zero or
  // multiple — the DB CHECK would catch it anyway but the message is
  // clearer here.
  const setKeys = [
    ["funder", a.funderId],
    ["non_funding_organization", a.organizationId],
    ["payment_intermediary", a.paymentIntermediaryId],
    ["household", a.householdId],
  ].filter(([, v]) => !!v) as [string, string][];
  if (setKeys.length === 0) {
    // The AI proposed creating a personnel role but couldn't tie it to
    // a funder/organization in the CRM (the entity FK is optional in
    // the tool schema). A role row can't exist without an entity, so
    // there's nothing to apply — skip it (don't hard-fail) so the rest
    // of the card's actions (e.g. set_phone) still go through.
    return {
      type: a.type,
      status: "skipped",
      message:
        "No matching organization on file, so the role wasn't created. Link the organization first, then add the role manually.",
    };
  }
  if (setKeys.length > 1) {
    return {
      type: a.type,
      status: "failed",
      message: `create_per requires exactly one entity FK; got ${setKeys.length}.`,
    };
  }
  const [entityType, entityId] = setKeys[0];

  // Re-validate the IDs exist.
  const [personOk] = await tx
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, a.personId))
    .limit(1);
  if (!personOk) {
    return { type: a.type, status: "failed", message: `Person ${a.personId} not found.` };
  }
  const entityOk = await entityExists(tx, entityType, entityId);
  if (!entityOk) {
    return {
      type: a.type,
      status: "failed",
      message: `Entity ${entityType} ${entityId} not found.`,
    };
  }

  // Avoid creating a dup current role for the same (person, entity).
  const existing = await findExistingCurrentPer(tx, a.personId, entityType, entityId);
  if (existing) {
    return {
      type: a.type,
      status: "skipped",
      message: `Role already exists (${existing}).`,
    };
  }

  const id = newId();
  await tx.insert(peopleEntityRoles).values({
    id,
    personId: a.personId,
    entityType: entityType as "funder" | "non_funding_organization" | "payment_intermediary" | "household",
    funderId: a.funderId ?? null,
    organizationId: a.organizationId ?? null,
    paymentIntermediaryId: a.paymentIntermediaryId ?? null,
    householdId: a.householdId ?? null,
    connection: a.connection ?? null,
    externalTitleOrRole: a.externalTitleOrRole ?? null,
    current: "current",
    primaryContact: false,
  });
  return { type: a.type, status: "applied", createdId: id };
}

async function applyCreatePersonWithPer(
  tx: Tx,
  a: Extract<ProposedAction, { type: "create_person_with_per" }>,
  ctx: { mailboxUserId: string },
): Promise<ApplyActionResult> {
  // Pre-check: don't create a duplicate person if one already exists
  // for the email address.
  if (a.emailAddress) {
    const [existing] = await tx
      .select({ personId: emailsTable.personId })
      .from(emailsTable)
      .where(ilike(emailsTable.email, a.emailAddress))
      .limit(1);
    if (existing?.personId) {
      return {
        type: a.type,
        status: "skipped",
        message: `Person already exists with this email (id=${existing.personId}).`,
      };
    }
  }

  const setKeys = [
    ["funder", a.funderId],
    ["non_funding_organization", a.organizationId],
  ].filter(([, v]) => !!v) as [string, string][];
  if (setKeys.length > 1) {
    return {
      type: a.type,
      status: "failed",
      message: "create_person_with_per accepts at most one of funderId / organizationId.",
    };
  }

  const personId = newId();
  await tx.insert(people).values({
    id: personId,
    firstName: a.firstName,
    lastName: a.lastName,
    fullName: `${a.firstName} ${a.lastName}`.trim(),
    ownerUserId: ctx.mailboxUserId,
  });
  if (a.emailAddress) {
    await tx.insert(emailsTable).values({
      id: newId(),
      email: a.emailAddress,
      personId,
      type: "work",
      isPreferred: true,
      validity: "unknown",
    });
  }
  let createdPerId: string | undefined;
  if (setKeys.length === 1) {
    const [entityType, entityId] = setKeys[0];
    const entityOk = await entityExists(tx, entityType, entityId);
    if (entityOk) {
      createdPerId = newId();
      await tx.insert(peopleEntityRoles).values({
        id: createdPerId,
        personId,
        entityType: entityType as "funder" | "non_funding_organization",
        funderId: a.funderId ?? null,
        organizationId: a.organizationId ?? null,
        connection: a.connection ?? null,
        externalTitleOrRole: a.externalTitleOrRole ?? null,
        current: "current",
        primaryContact: false,
      });
    }
  }
  return {
    type: a.type,
    status: "applied",
    createdId: personId,
    message: createdPerId ? `Role: ${createdPerId}` : "Person created without role.",
  };
}

async function applyCreateOrgWithPer(
  tx: Tx,
  a: Extract<ProposedAction, { type: "create_org_with_per" }>,
  ctx: { mailboxUserId: string },
): Promise<ApplyActionResult> {
  // Person must still exist (could have been deleted between proposal
  // creation and accept).
  const [personOk] = await tx
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, a.personId))
    .limit(1);
  if (!personOk) {
    return { type: a.type, status: "failed", message: `Person ${a.personId} not found.` };
  }

  // Reuse an existing org with the same name (case-insensitive) instead
  // of creating a duplicate — the org may have been added since the
  // proposal was generated.
  const [existingOrg] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`lower(${organizations.name}) = lower(${a.organizationName})`)
    .limit(1);

  let organizationId: string = existingOrg?.id ?? "";
  let createdOrg = false;
  if (!organizationId) {
    organizationId = newId();
    await tx.insert(organizations).values({
      id: organizationId,
      name: a.organizationName,
      type: a.organizationType ?? null,
      emailDomain: a.emailDomain ?? null,
      ownerUserId: ctx.mailboxUserId,
    });
    createdOrg = true;
  }

  // Don't create a duplicate current role for the same (person, org).
  const existingRole = await findExistingCurrentPer(
    tx,
    a.personId,
    "non_funding_organization",
    organizationId,
  );
  if (existingRole) {
    return {
      type: a.type,
      status: createdOrg ? "applied" : "skipped",
      createdId: organizationId,
      message: createdOrg
        ? `Organization created (${organizationId}); role already existed.`
        : `Role already exists (${existingRole}).`,
    };
  }

  const roleId = newId();
  await tx.insert(peopleEntityRoles).values({
    id: roleId,
    personId: a.personId,
    entityType: "non_funding_organization",
    organizationId,
    connection: a.connection ?? null,
    externalTitleOrRole: a.externalTitleOrRole ?? null,
    current: "current",
    primaryContact: false,
  });
  return {
    type: a.type,
    status: "applied",
    createdId: organizationId,
    message: createdOrg
      ? `Created organization "${a.organizationName}" + role (${roleId}).`
      : `Linked to existing organization; role ${roleId}.`,
  };
}

async function applyCreateFunderWithPer(
  tx: Tx,
  a: Extract<ProposedAction, { type: "create_funder_with_per" }>,
  ctx: { mailboxUserId: string },
): Promise<ApplyActionResult> {
  // Person must still exist (could have been deleted between proposal
  // creation and accept).
  const [personOk] = await tx
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, a.personId))
    .limit(1);
  if (!personOk) {
    return { type: a.type, status: "failed", message: `Person ${a.personId} not found.` };
  }

  // Reuse an existing funder with the same name (case-insensitive) instead
  // of creating a duplicate — one may have been added since the proposal
  // was generated.
  const [existingFunder] = await tx
    .select({ id: funders.id })
    .from(funders)
    .where(sql`lower(${funders.name}) = lower(${a.funderName})`)
    .limit(1);

  let funderId: string = existingFunder?.id ?? "";
  let createdFunder = false;
  if (!funderId) {
    funderId = newId();
    await tx.insert(funders).values({
      id: funderId,
      name: a.funderName,
      emailDomain: a.emailDomain ?? null,
      ownerUserId: ctx.mailboxUserId,
    });
    createdFunder = true;
  }

  // Don't create a duplicate current role for the same (person, funder).
  const existingRole = await findExistingCurrentPer(tx, a.personId, "funder", funderId);
  if (existingRole) {
    return {
      type: a.type,
      status: createdFunder ? "applied" : "skipped",
      createdId: funderId,
      message: createdFunder
        ? `Funder created (${funderId}); role already existed.`
        : `Role already exists (${existingRole}).`,
    };
  }

  const roleId = newId();
  await tx.insert(peopleEntityRoles).values({
    id: roleId,
    personId: a.personId,
    entityType: "funder",
    funderId,
    connection: a.connection ?? null,
    externalTitleOrRole: a.externalTitleOrRole ?? null,
    current: "current",
    primaryContact: false,
  });
  return {
    type: a.type,
    status: "applied",
    createdId: funderId,
    message: createdFunder
      ? `Created funder "${a.funderName}" + role (${roleId}).`
      : `Linked to existing funder; role ${roleId}.`,
  };
}

async function applyAddEmail(
  tx: Tx,
  a: Extract<ProposedAction, { type: "add_email" }>,
): Promise<ApplyActionResult> {
  const [existing] = await tx
    .select({ id: emailsTable.id })
    .from(emailsTable)
    .where(and(eq(emailsTable.personId, a.personId), ilike(emailsTable.email, a.emailAddress)))
    .limit(1);
  if (existing) {
    if (a.setPrimary) {
      await tx
        .update(emailsTable)
        .set({ isPreferred: false, updatedAt: new Date() })
        .where(eq(emailsTable.personId, a.personId));
      await tx
        .update(emailsTable)
        .set({ isPreferred: true, updatedAt: new Date() })
        .where(eq(emailsTable.id, existing.id));
      return {
        type: a.type,
        status: "applied",
        message: `Existing email promoted to primary.`,
        createdId: existing.id,
      };
    }
    return {
      type: a.type,
      status: "skipped",
      message: "Email already on file for this person.",
    };
  }
  if (a.setPrimary) {
    await tx
      .update(emailsTable)
      .set({ isPreferred: false, updatedAt: new Date() })
      .where(eq(emailsTable.personId, a.personId));
  }
  const id = newId();
  await tx.insert(emailsTable).values({
    id,
    email: a.emailAddress,
    personId: a.personId,
    type: a.emailType ?? "work",
    isPreferred: a.setPrimary ?? false,
    validity: "unknown",
  });
  return { type: a.type, status: "applied", createdId: id };
}

async function applySetPrimaryEmail(
  tx: Tx,
  a: Extract<ProposedAction, { type: "set_primary_email" }>,
): Promise<ApplyActionResult> {
  let targetId = a.emailId ?? null;
  let personId = a.personId ?? null;
  if (!targetId && personId && a.emailAddress) {
    const [hit] = await tx
      .select({ id: emailsTable.id })
      .from(emailsTable)
      .where(and(eq(emailsTable.personId, personId), ilike(emailsTable.email, a.emailAddress)))
      .limit(1);
    targetId = hit?.id ?? null;
  }
  if (!targetId) {
    return { type: a.type, status: "skipped", message: "Email not found." };
  }
  if (!personId) {
    const [row] = await tx
      .select({ personId: emailsTable.personId })
      .from(emailsTable)
      .where(eq(emailsTable.id, targetId))
      .limit(1);
    personId = row?.personId ?? null;
  }
  if (personId) {
    await tx
      .update(emailsTable)
      .set({ isPreferred: false, updatedAt: new Date() })
      .where(eq(emailsTable.personId, personId));
  }
  await tx
    .update(emailsTable)
    .set({ isPreferred: true, updatedAt: new Date() })
    .where(eq(emailsTable.id, targetId));
  return { type: a.type, status: "applied", createdId: targetId };
}

async function applyMarkEmailInvalid(
  tx: Tx,
  a: Extract<ProposedAction, { type: "mark_email_invalid" }>,
): Promise<ApplyActionResult> {
  const rows = await tx
    .update(emailsTable)
    .set({ validity: "invalid", updatedAt: new Date() })
    .where(ilike(emailsTable.email, a.emailAddress))
    .returning({ id: emailsTable.id });
  if (rows.length === 0) {
    return { type: a.type, status: "skipped", message: "No email row matched." };
  }
  return {
    type: a.type,
    status: "applied",
    message: `${rows.length} email row(s) marked invalid.`,
  };
}

async function applyCreateGrantOpportunity(
  tx: Tx,
  a: Extract<ProposedAction, { type: "create_grant_opportunity" }>,
  ctx: { mailboxUserId: string },
): Promise<ApplyActionResult> {
  let funderId = a.funderId ?? null;
  if (!funderId && a.funderName) {
    const [hit] = await tx
      .select({ id: funders.id })
      .from(funders)
      .where(ilike(funders.name, `%${a.funderName}%`))
      .limit(1);
    funderId = hit?.id ?? null;
  }
  if (!funderId) {
    return {
      type: a.type,
      status: "skipped",
      message: "No matching funder in CRM — create the funder first.",
    };
  }
  // Confirm the funder still exists (might have been deleted).
  const [fOk] = await tx
    .select({ id: funders.id })
    .from(funders)
    .where(eq(funders.id, funderId))
    .limit(1);
  if (!fOk) {
    return { type: a.type, status: "failed", message: `Funder ${funderId} not found.` };
  }

  const oppId = newId();
  await tx.insert(opportunitiesAndPledges).values({
    id: oppId,
    name: a.title.slice(0, 200),
    funderId,
    status: "open",
    stage: a.stage ?? "cold_lead",
    askAmount: a.askAmount != null ? String(a.askAmount) : null,
    ownerUserId: ctx.mailboxUserId,
  });
  // Required companion row — every opportunity needs at least one
  // pledge_allocations entry.
  await tx.insert(pledgeAllocations).values({
    id: newId(),
    pledgeOrOpportunityId: oppId,
    status: "working",
  });
  return { type: a.type, status: "applied", createdId: oppId };
}

async function applySetPhone(
  tx: Tx,
  a: Extract<ProposedAction, { type: "set_phone" }>,
): Promise<ApplyActionResult> {
  // Confirm the person still exists.
  const [personOk] = await tx
    .select({ id: people.id })
    .from(people)
    .where(eq(people.id, a.personId))
    .limit(1);
  if (!personOk) {
    return { type: a.type, status: "failed", message: `Person ${a.personId} not found.` };
  }

  // Dedup on digits only (ignore formatting / country-code prefix) so
  // "+1 (555) 123-4567" doesn't get re-added next to "555-123-4567".
  const incomingDigits = a.phoneNumber.replace(/\D/g, "");
  const existingRows = await tx
    .select({ id: phoneNumbers.id, phoneNumber: phoneNumbers.phoneNumber })
    .from(phoneNumbers)
    .where(eq(phoneNumbers.personId, a.personId));
  const dupe = existingRows.find((r: { id: string; phoneNumber: string }) => {
    const d = r.phoneNumber.replace(/\D/g, "");
    return d.length > 0 && (d === incomingDigits || d.endsWith(incomingDigits) || incomingDigits.endsWith(d));
  });
  if (dupe) {
    if (a.setPrimary) {
      await tx
        .update(phoneNumbers)
        .set({ isPreferred: false, updatedAt: new Date() })
        .where(eq(phoneNumbers.personId, a.personId));
      await tx
        .update(phoneNumbers)
        .set({ isPreferred: true, updatedAt: new Date() })
        .where(eq(phoneNumbers.id, dupe.id));
      return { type: a.type, status: "applied", message: "Existing phone promoted to primary.", createdId: dupe.id };
    }
    return { type: a.type, status: "skipped", message: "Phone already on file for this person." };
  }

  if (a.setPrimary) {
    await tx
      .update(phoneNumbers)
      .set({ isPreferred: false, updatedAt: new Date() })
      .where(eq(phoneNumbers.personId, a.personId));
  }
  const id = newId();
  await tx.insert(phoneNumbers).values({
    id,
    personId: a.personId,
    phoneNumber: a.phoneNumber,
    type: a.phoneType ?? "work",
    isPreferred: a.setPrimary ?? false,
    validity: "unknown",
  });
  return { type: a.type, status: "applied", createdId: id };
}

async function applyUpdatePerTitle(
  tx: Tx,
  a: Extract<ProposedAction, { type: "update_per_title" }>,
): Promise<ApplyActionResult> {
  const [per] = await tx
    .select({
      id: peopleEntityRoles.id,
      externalTitleOrRole: peopleEntityRoles.externalTitleOrRole,
      current: peopleEntityRoles.current,
    })
    .from(peopleEntityRoles)
    .where(eq(peopleEntityRoles.id, a.perId))
    .limit(1);
  if (!per) {
    return { type: a.type, status: "failed", message: `Role ${a.perId} not found.` };
  }
  // Never rewrite a historical role's title — title updates only make
  // sense for the role the person currently holds.
  if (per.current !== "current") {
    return { type: a.type, status: "skipped", message: "Role is not current; title left unchanged." };
  }
  if ((per.externalTitleOrRole ?? "") === a.externalTitleOrRole) {
    return { type: a.type, status: "skipped", message: "Title already matches." };
  }
  await tx
    .update(peopleEntityRoles)
    .set({ externalTitleOrRole: a.externalTitleOrRole, updatedAt: new Date() })
    .where(eq(peopleEntityRoles.id, a.perId));
  return { type: a.type, status: "applied", createdId: a.perId };
}

// ──────────────────────────────────────────────────────────────────

async function entityExists(tx: Tx, entityType: string, id: string): Promise<boolean> {
  switch (entityType) {
    case "funder": {
      const [r] = await tx.select({ id: funders.id }).from(funders).where(eq(funders.id, id)).limit(1);
      return !!r;
    }
    case "non_funding_organization": {
      const [r] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id)).limit(1);
      return !!r;
    }
    case "payment_intermediary": {
      const [r] = await tx.select({ id: paymentIntermediaries.id }).from(paymentIntermediaries).where(eq(paymentIntermediaries.id, id)).limit(1);
      return !!r;
    }
    case "household": {
      const [r] = await tx.select({ id: households.id }).from(households).where(eq(households.id, id)).limit(1);
      return !!r;
    }
    default:
      return false;
  }
}

async function findExistingCurrentPer(
  tx: Tx,
  personId: string,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const col =
    entityType === "funder"
      ? peopleEntityRoles.funderId
      : entityType === "non_funding_organization"
        ? peopleEntityRoles.organizationId
        : entityType === "payment_intermediary"
          ? peopleEntityRoles.paymentIntermediaryId
          : peopleEntityRoles.householdId;
  const [hit] = await tx
    .select({ id: peopleEntityRoles.id })
    .from(peopleEntityRoles)
    .where(
      and(
        eq(peopleEntityRoles.personId, personId),
        eq(col, entityId),
        eq(peopleEntityRoles.current, "current"),
      ),
    )
    .limit(1);
  return hit?.id ?? null;
}

void sql;
