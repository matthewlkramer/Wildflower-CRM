import { describe, expect, it } from "vitest";
import { applyAction } from "../lib/applyProposalActions";
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
