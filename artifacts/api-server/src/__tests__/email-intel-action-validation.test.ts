import { describe, expect, it } from "vitest";
import { sanitizeProposedActions } from "../lib/emailIntelActionValidation";
import type { PersonContext, ProposedAction } from "../lib/proposeActions";

function context(overrides: Partial<PersonContext> = {}): PersonContext {
  return {
    id: "person_contact",
    fullName: "Contact Person",
    emails: [],
    phones: [],
    roles: [],
    ...overrides,
  };
}

describe("sanitizeProposedActions", () => {
  it("drops a phone action when the number is already on file despite formatting", () => {
    const actions: ProposedAction[] = [
      {
        type: "set_phone",
        personId: "person_contact",
        phoneNumber: "+1 (612) 916-3171",
        reason: "Signature lists a phone.",
      },
    ];
    const result = sanitizeProposedActions({
      actions,
      proposalSentAt: new Date("2026-09-01T00:00:00Z"),
      personContext: context({
        phones: [
          {
            id: "phone_1",
            phoneNumber: "612-916-3171",
            type: "mobile",
            isPreferred: true,
          },
        ],
      }),
      mailboxOwnerContext: null,
    });
    expect(result).toEqual([]);
  });

  it("drops a mailbox owner's phone and role when assigned to a correspondent", () => {
    const owner = context({
      id: "person_owner",
      fullName: "Matthew Kramer",
      phones: [
        {
          id: "owner_phone",
          phoneNumber: "612 916 3171",
          type: "mobile",
          isPreferred: true,
        },
      ],
      roles: [
        {
          id: "owner_role",
          entityType: "organization",
          entityName: "The Wildflower Foundation",
          organizationId: "org_wildflower",
          connection: "employee",
          externalTitleOrRole: "CEO",
          current: "current",
          updatedAt: new Date("2025-01-01T00:00:00Z"),
          entityHistoricalNames: null,
        },
      ],
    });
    const actions: ProposedAction[] = [
      {
        type: "set_phone",
        personId: "person_contact",
        phoneNumber: "(612) 916-3171",
        reason: "Signature lists this number.",
      },
      {
        type: "create_per",
        personId: "person_contact",
        organizationId: "org_wildflower",
        entityName: "The Wildflower Foundation",
        externalTitleOrRole: "CEO",
        reason: "Signature says CEO.",
      },
    ];
    expect(
      sanitizeProposedActions({
        actions,
        proposalSentAt: new Date("2026-09-01T00:00:00Z"),
        personContext: context(),
        mailboxOwnerContext: owner,
      }),
    ).toEqual([]);
  });

  it("does not recreate a current role or revive a past role from older evidence", () => {
    const personContext = context({
      roles: [
        {
          id: "role_current",
          entityType: "organization",
          entityName: "Current Org",
          organizationId: "org_current",
          connection: "employee",
          externalTitleOrRole: "Director",
          current: "current",
          updatedAt: new Date("2025-01-01T00:00:00Z"),
          entityHistoricalNames: null,
        },
        {
          id: "role_past",
          entityType: "organization",
          entityName: "Former Org",
          organizationId: "org_past",
          connection: "employee",
          externalTitleOrRole: "Manager",
          current: "past",
          updatedAt: new Date("2025-06-01T00:00:00Z"),
          entityHistoricalNames: null,
        },
      ],
    });
    const actions: ProposedAction[] = [
      {
        type: "create_per",
        personId: "person_contact",
        organizationId: "org_current",
        reason: "Current signature.",
      },
      {
        type: "create_per",
        personId: "person_contact",
        organizationId: "org_past",
        reason: "Historical signature.",
      },
    ];
    expect(
      sanitizeProposedActions({
        actions,
        proposalSentAt: new Date("2024-01-01T00:00:00Z"),
        personContext,
        mailboxOwnerContext: null,
      }),
    ).toEqual([]);
  });

  it("keeps a genuinely new phone action", () => {
    const action: ProposedAction = {
      type: "set_phone",
      personId: "person_contact",
      phoneNumber: "651-555-0199",
      reason: "Sender's labeled mobile number.",
    };
    expect(
      sanitizeProposedActions({
        actions: [action],
        proposalSentAt: new Date("2026-09-01T00:00:00Z"),
        personContext: context(),
        mailboxOwnerContext: null,
      }),
    ).toEqual([action]);
  });
});
