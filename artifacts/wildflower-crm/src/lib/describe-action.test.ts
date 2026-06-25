import { describe, expect, it } from "vitest";
import { describeAction } from "../pages/email-intelligence";

describe("describeAction", () => {
  it("names the person on add_email", () => {
    expect(
      describeAction({
        type: "add_email",
        emailAddress: "jane@example.org",
        personName: "Jane Doe",
      }),
    ).toBe("Add email jane@example.org to Jane Doe");
  });

  it("names the organization on add_email when the target is an org", () => {
    expect(
      describeAction({
        type: "add_email",
        emailAddress: "info@acme.org",
        organizationName: "Acme Foundation",
      }),
    ).toBe("Add email info@acme.org to Acme Foundation");
  });

  it("falls back to 'person' on add_email when no name resolves", () => {
    expect(
      describeAction({
        type: "add_email",
        emailAddress: "x@example.org",
      }),
    ).toBe("Add email x@example.org to person");
  });

  it("names the person on set_phone", () => {
    expect(
      describeAction({
        type: "set_phone",
        phoneNumber: "+1 555-123-4567",
        phoneType: "mobile",
        personName: "Sam Lee",
      }),
    ).toBe("Add phone +1 555-123-4567 (mobile) to Sam Lee");
  });

  it("names the organization on set_phone", () => {
    expect(
      describeAction({
        type: "set_phone",
        phoneNumber: "+1 555-000-0000",
        organizationName: "Acme Foundation",
      }),
    ).toBe("Add phone +1 555-000-0000 to Acme Foundation");
  });

  it("names the person on set_primary_email", () => {
    expect(
      describeAction({
        type: "set_primary_email",
        emailAddress: "jane@example.org",
        personName: "Jane Doe",
      }),
    ).toBe("Promote jane@example.org to primary for Jane Doe");
  });

  it("names the organization on set_primary_email", () => {
    expect(
      describeAction({
        type: "set_primary_email",
        emailId: "em_1",
        organizationName: "Acme Foundation",
      }),
    ).toBe("Promote em_1 to primary for Acme Foundation");
  });

  it("renders Title @ Entity for deactivate_per", () => {
    expect(
      describeAction({
        type: "deactivate_per",
        perId: "per_1",
        roleTitle: "Program Officer",
        roleEntityName: "Acme Foundation",
      }),
    ).toBe("Mark role inactive: Program Officer @ Acme Foundation");
  });

  it("falls back to the role id for deactivate_per when unresolved", () => {
    expect(
      describeAction({ type: "deactivate_per", perId: "per_9" }),
    ).toBe("Mark current role inactive (role id per_9)");
  });

  it("renders Title @ Entity for update_per_title", () => {
    expect(
      describeAction({
        type: "update_per_title",
        perId: "per_1",
        externalTitleOrRole: "Executive Director",
        roleEntityName: "Acme Foundation",
      }),
    ).toBe('Update role title to "Executive Director" @ Acme Foundation');
  });

  it("falls back to the role id for update_per_title when unresolved", () => {
    expect(
      describeAction({
        type: "update_per_title",
        perId: "per_2",
        externalTitleOrRole: "Director",
      }),
    ).toBe('Update role title to "Director" (role id per_2)');
  });
});
