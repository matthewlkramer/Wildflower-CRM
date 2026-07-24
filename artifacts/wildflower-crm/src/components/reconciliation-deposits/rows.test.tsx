import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkbenchDeposit } from "@workspace/api-client-react";
import { DEPOSIT_LENSES, DepositRow } from "./rows";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeDeposit(overrides: Partial<WorkbenchDeposit> = {}): WorkbenchDeposit {
  return {
    id: "bank_deposit:test",
    kind: "bank_deposit",
    anchorId: "test",
    status: "open",
    date: "2024-01-02",
    title: "Test deposit",
    lenses: ["all_open"],
    bank: {
      amount: "100.00",
      currency: "USD",
      account: "Wells Fargo",
      location: null,
      reference: "ref",
      memo: "Test memo",
    },
    composition: {
      kind: "unresolved",
      payoutId: null,
      explainedAmount: "0.00",
      unexplainedAmount: "100.00",
      components: [],
      units: [],
    },
    gifts: [],
    charges: [],
    qbRecords: [],
    accountingChecks: [],
    coverage: {} as WorkbenchDeposit["coverage"],
    ...overrides,
  };
}

function render(deposit: WorkbenchDeposit) {
  act(() => root.render(<DepositRow deposit={deposit} expanded onToggle={() => undefined} />));
}

describe("deposit workbench rows", () => {
  it("renders payout, component, and unresolved compositions", () => {
    render(makeDeposit({
      composition: {
        kind: "stripe_payout",
        payoutId: "po_1",
        explainedAmount: "100.00",
        unexplainedAmount: "0.00",
        components: [],
      },
      charges: [{
        chargeId: "ch_1",
        amount: "100.00",
        feeAmount: "0.00",
        netAmount: "100.00",
        payerName: "Payer",
        chargeDate: "2024-01-02",
        linkedGiftId: null,
        attributedDonor: null,
      }],
    }));
    expect(container.textContent).toContain("Stripe payout");
    expect(container.textContent).toContain("Payer");

    render(makeDeposit({
      composition: {
        kind: "components",
        payoutId: null,
        explainedAmount: "100.00",
        unexplainedAmount: "0.00",
        components: [{
          componentId: "component_1",
          paymentUnitId: "unit_1",
          amount: "100.00",
          kind: "check",
          needsReview: false,
          ambiguousDepositMatch: false,
          countedGiftIds: [],
        }],
        units: [],
      },
    }));
    expect(container.textContent).toContain("check");

    render(makeDeposit());
    expect(container.textContent).toContain("Unresolved composition");
  });

  it("marks not-fundraising rows and exposes the eight lens labels", () => {
    render(makeDeposit({ lenses: ["not_fundraising"] }));
    expect(container.textContent).toContain("Not fundraising");
    expect(DEPOSIT_LENSES).toHaveLength(8);
    expect(DEPOSIT_LENSES.map((lens) => lens.id)).toContain("accounting_corrections");
  });
});
