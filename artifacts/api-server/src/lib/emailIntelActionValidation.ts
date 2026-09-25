import { organizationNamesEquivalent } from "./organizationNameMatching";
import type { PersonContext, ProposedAction } from "./proposeActions";

function normalizedPhone(raw: string | null | undefined): string {
  const digits = raw?.replace(/\D/g, "") ?? "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
}

function normalizedText(raw: string | null | undefined): string {
  return raw?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function samePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizedPhone(a);
  const right = normalizedPhone(b);
  return left.length >= 10 && right.length >= 10 && left === right;
}

function roleMatchesAction(
  role: PersonContext["roles"][number],
  action: ProposedAction,
): boolean {
  if (action.type === "create_per") {
    return (
      !!action.organizationId && action.organizationId === role.organizationId
    );
  }
  if (action.type === "create_org_with_per") {
    return organizationNamesEquivalent(
      action.organizationName,
      role.entityName ?? "",
    );
  }
  if (action.type === "create_funder_with_per") {
    return organizationNamesEquivalent(
      action.funderName,
      role.entityName ?? "",
    );
  }
  if (action.type === "update_per_title") {
    return action.perId === role.id;
  }
  return false;
}

function actionPersonId(action: ProposedAction): string | null {
  switch (action.type) {
    case "create_per":
    case "create_org_with_per":
    case "create_funder_with_per":
    case "add_email":
    case "set_phone":
      return action.personId;
    case "set_primary_email":
      return action.personId ?? null;
    default:
      return null;
  }
}

/** Deterministic safety net after the model responds. Prompt instructions are
 * advisory; stored actions must independently prove that they are new, timely,
 * and belong to the correspondent rather than the mailbox owner. */
export function sanitizeProposedActions(args: {
  actions: ProposedAction[];
  proposalSentAt: Date | null;
  personContext: PersonContext | null;
  mailboxOwnerContext: PersonContext | null;
}): ProposedAction[] {
  const { proposalSentAt, personContext, mailboxOwnerContext } = args;
  return args.actions.filter((action) => {
    const targetPersonId = actionPersonId(action);
    const targetIsOwner =
      !!targetPersonId && targetPersonId === mailboxOwnerContext?.id;

    if (action.type === "set_phone") {
      if (
        /already (?:on file|matches)|matches .*on file|same .*on file/i.test(
          action.reason,
        )
      ) {
        return false;
      }
      if (
        personContext?.id === action.personId &&
        personContext.phones.some((phone) =>
          samePhone(phone.phoneNumber, action.phoneNumber),
        )
      ) {
        return false;
      }
      if (
        mailboxOwnerContext &&
        !targetIsOwner &&
        mailboxOwnerContext.phones.some((phone) =>
          samePhone(phone.phoneNumber, action.phoneNumber),
        )
      ) {
        return false;
      }
    }

    if (action.type === "add_email") {
      const email = normalizedText(action.emailAddress);
      if (
        personContext?.id === action.personId &&
        personContext.emails.some(
          (existing) => normalizedText(existing.email) === email,
        )
      ) {
        return false;
      }
      if (
        mailboxOwnerContext &&
        !targetIsOwner &&
        mailboxOwnerContext.emails.some(
          (existing) => normalizedText(existing.email) === email,
        )
      ) {
        return false;
      }
    }

    if (action.type === "update_per_title" && personContext) {
      const role = personContext.roles.find(
        (candidate) => candidate.id === action.perId,
      );
      if (!role || role.current !== "current") return false;
      if (
        normalizedText(role.externalTitleOrRole) ===
        normalizedText(action.externalTitleOrRole)
      ) {
        return false;
      }
    }

    if (
      (action.type === "create_per" ||
        action.type === "create_org_with_per" ||
        action.type === "create_funder_with_per") &&
      personContext?.id === action.personId
    ) {
      const sameRoles = personContext.roles.filter((role) =>
        roleMatchesAction(role, action),
      );
      if (sameRoles.some((role) => role.current === "current")) return false;
      if (
        proposalSentAt &&
        sameRoles.some(
          (role) => role.current === "past" && proposalSentAt < role.updatedAt,
        )
      ) {
        return false;
      }
    }

    if (mailboxOwnerContext && !targetIsOwner) {
      const actionTitle =
        action.type === "update_per_title" ||
        action.type === "create_per" ||
        action.type === "create_org_with_per" ||
        action.type === "create_funder_with_per"
          ? normalizedText(action.externalTitleOrRole)
          : "";
      if (actionTitle) {
        const ownerRoleMatch = mailboxOwnerContext.roles.some((ownerRole) => {
          if (normalizedText(ownerRole.externalTitleOrRole) !== actionTitle)
            return false;
          if (action.type === "update_per_title") {
            return (
              normalizedText(action.roleEntityName) ===
              normalizedText(ownerRole.entityName)
            );
          }
          return roleMatchesAction(ownerRole, action);
        });
        if (ownerRoleMatch) return false;
      }
    }

    return true;
  });
}
