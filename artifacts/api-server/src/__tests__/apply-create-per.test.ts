import { describe, expect, it } from "vitest";
import { applyAction, validateAction } from "../lib/applyProposalActions";
import type { ProposedAction } from "../lib/proposeActions";

// A tx stub that throws if touched — the no-entity-FK create_per path
// must short-circuit before issuing any DB query.
const explodingTx = new Proxy(
  {},
  {
    get() {
      throw new Error("tx should not be used for an unsatisfiable create_per");
    },
  },
);

const ctx = { mailboxUserId: "user_test" };

describe("applyAction: create_per without an entity FK", () => {
  it("skips (does not fail) when no funder/org/intermediary/household is set", async () => {
    const action = {
      type: "create_per",
      personId: "recPerson",
      connection: "principal",
      externalTitleOrRole: "Founder, Chief Executive Officer",
      reason: "Signature shows a role but no matching org in CRM.",
    } as unknown as ProposedAction;

    const result = await applyAction(explodingTx, action, ctx);

    expect(result.type).toBe("create_per");
    expect(result.status).toBe("skipped");
    expect(result.message).toMatch(/organization/i);
  });
});

describe("validateAction: create_org_with_per", () => {
  it("accepts a well-formed create_org_with_per", () => {
    const res = validateAction({
      type: "create_org_with_per",
      personId: "recPerson",
      organizationName: "Phoenix Charter Academy Network",
      organizationType: "cmo",
      emailDomain: "phoenixcharteracademy.org",
      connection: "principal",
      externalTitleOrRole: "Founder, Chief Executive Officer",
      reason: "Signature shows a charter network not yet in the CRM.",
    });
    expect(res.ok).toBe(true);
  });

  it("rejects when organizationName is missing", () => {
    const res = validateAction({
      type: "create_org_with_per",
      personId: "recPerson",
      reason: "missing org name",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/organizationName/);
  });
});

describe("validateAction: create_funder_with_per", () => {
  it("accepts a well-formed create_funder_with_per", () => {
    const res = validateAction({
      type: "create_funder_with_per",
      personId: "recPerson",
      funderName: "Colorado Schools Fund",
      emailDomain: "coloradoschoolsfund.org",
      connection: "employee",
      externalTitleOrRole: "Executive Assistant",
      reason: "Funder not yet in CRM; proposing for review.",
    });
    expect(res.ok).toBe(true);
  });

  it("rejects when funderName is missing", () => {
    const res = validateAction({
      type: "create_funder_with_per",
      personId: "recPerson",
      reason: "missing funder name",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/funderName/);
  });
});
