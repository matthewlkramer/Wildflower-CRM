import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkbenchDeposit } from "@workspace/api-client-react";
import type { ClusterActions } from "@/components/reconciliation-clusters/actions";
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
      payee: "Example Payee",
      refNo: "REF-123",
      txnType: "Deposit",
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

function render(deposit: WorkbenchDeposit, actions?: Partial<ClusterActions>) {
  act(() => root.render(<DepositRow deposit={deposit} expanded onToggle={() => undefined} actions={actions as ClusterActions | undefined} />));
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
    expect(container.textContent).toContain("Example Payee · REF-123");
    expect(container.textContent).not.toContain("QBO:");
  });

  it("marks not-fundraising rows and exposes the eight lens labels", () => {
    render(makeDeposit({ lenses: ["not_fundraising"] }));
    expect(container.textContent).toContain("Not fundraising");
    expect(DEPOSIT_LENSES).toHaveLength(8);
    expect(DEPOSIT_LENSES.map((lens) => lens.id)).toContain("accounting_corrections");
  });

  it("shows the finance-only exclusion reason list for an unexcluded deposit", () => {
    render(makeDeposit(), { isFinanceOrAdmin: true });
    const trigger = container.querySelector('button[aria-label="Card actions"]');
    expect(trigger).not.toBeNull();
    act(() => trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(document.body.textContent).toContain("Mark as non-WF money");
    expect(document.body.textContent).toContain("Mark as membership fee");
    expect(document.body.textContent).toContain("Mark as excluded — other…");
  });

  it("shows return-to-open-queue for a direct bank exclusion", () => {
    render(makeDeposit({
      bankExclusion: { reason: "membership", note: "reviewed" },
    }), { isFinanceOrAdmin: true });
    const trigger = container.querySelector('button[aria-label="Card actions"]');
    expect(trigger).not.toBeNull();
    act(() => trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(document.body.textContent).toContain("Return to open queue");
  });

  /** Open the card-actions menu whose content contains `text`; return the open menu content element. */
  function openMenuContaining(text: string): HTMLElement | null {
    const triggers = container.querySelectorAll('button[aria-label="Card actions"]');
    for (const trigger of triggers) {
      act(() => trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      if (menu?.textContent?.includes(text)) return menu;
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
    }
    return null;
  }

  function menuItem(menu: HTMLElement, label: string): HTMLElement | null {
    return (
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
        (item) => item.textContent?.includes(label),
      ) ?? null
    );
  }

  it("labels (never hides) blocked gifts-column actions when no evidence anchor exists", () => {
    render(makeDeposit(), { isFinanceOrAdmin: true });
    const menu = openMenuContaining("Create standalone gift…");
    expect(menu).not.toBeNull();
    for (const label of [
      "Search and link gift or pledge…",
      "Create standalone gift…",
      "Record as payment on pledge…",
    ]) {
      const item = menuItem(menu as HTMLElement, label);
      expect(item, label).not.toBeNull();
      expect(item?.getAttribute("data-disabled"), label).not.toBeNull();
    }
    expect(menu?.textContent).toContain(
      "No unlinked payment evidence — resolve the deposit's composition first.",
    );
  });

  it("enables every gift action — including the pledge path — for an unlinked charge anchor", () => {
    // QB-first gating is retired: Stripe money can be recorded directly as a
    // payment on a pledge (the server mints the gift under it); the QBO entry
    // is the LAST step, done later in QuickBooks.
    render(
      makeDeposit({
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
      }),
      { isFinanceOrAdmin: true },
    );
    const menu = openMenuContaining("Record as payment on pledge…");
    expect(menu).not.toBeNull();
    for (const label of [
      "Search and link gift or pledge…",
      "Create standalone gift…",
      "Record as payment on pledge…",
    ]) {
      expect(
        menuItem(menu as HTMLElement, label)?.getAttribute("data-disabled"),
        label,
      ).toBeNull();
    }
  });

  it("enables all unit-backed gift actions for a manual gift-less payment", () => {
    // "Record without a gift" leaves a manual bank_spine component whose unit
    // has no gift and no QB staged source. Linking an existing gift (adopt-unit
    // path), minting a standalone gift, identifying the donor, and recording a
    // pledge payment all act on the decomposed payment unit — no QB record
    // needed (QB-first gating is retired).
    render(
      makeDeposit({
        composition: {
          kind: "components",
          payoutId: null,
          explainedAmount: "100.00",
          unexplainedAmount: "0.00",
          components: [{
            componentId: "component_manual",
            paymentUnitId: "unit_manual",
            amount: "100.00",
            kind: "other",
            needsReview: false,
            ambiguousDepositMatch: false,
            countedGiftIds: [],
            source: "bank_spine",
            stagedPaymentId: null,
            label: null,
          }],
          units: [],
        },
      }),
      { isFinanceOrAdmin: true },
    );
    const menu = openMenuContaining("Create standalone gift…");
    expect(menu).not.toBeNull();
    for (const label of [
      "Search and link gift or pledge…",
      "Create standalone gift…",
      "Identify donor…",
      "Record as payment on pledge…",
    ]) {
      expect(
        menuItem(menu as HTMLElement, label)?.getAttribute("data-disabled"),
        label,
      ).toBeNull();
    }
    expect(menu?.textContent).not.toContain(
      "No unlinked payment evidence — resolve the deposit's composition first.",
    );
  });

  it("falls back to the unit-backed component anchor when the staged QB row is no longer actionable", () => {
    // A component can carry a staged QB source that has since become
    // unavailable (booked elsewhere, excluded, or derived-excluded by a
    // confirmed charge tie). Staged-anchored actions would 409 — the row must
    // anchor on the payment unit instead; unit-backed actions (mint, pledge
    // payment) stay enabled.
    const stagedBackedComponent = (stagedActionable: boolean) =>
      makeDeposit({
        composition: {
          kind: "components",
          payoutId: null,
          explainedAmount: "100.00",
          unexplainedAmount: "0.00",
          components: [{
            componentId: "component_qb",
            paymentUnitId: "unit_qb",
            amount: "100.00",
            kind: "check",
            needsReview: false,
            ambiguousDepositMatch: false,
            countedGiftIds: [],
            source: "bank_spine",
            stagedPaymentId: "staged_1",
            stagedActionable,
            label: "Chia Rodeski",
          }],
          units: [],
        },
      });

    // Not actionable → component/unit anchor: mint and pledge path enabled
    // (the pledge payment mints from the unit, not the dead staged row).
    render(stagedBackedComponent(false), { isFinanceOrAdmin: true });
    let menu = openMenuContaining("Create standalone gift…");
    expect(menu).not.toBeNull();
    expect(
      menuItem(menu as HTMLElement, "Create standalone gift…")?.getAttribute("data-disabled"),
    ).toBeNull();
    expect(
      menuItem(menu as HTMLElement, "Record as payment on pledge…")?.getAttribute("data-disabled"),
    ).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    // Actionable → staged anchor: pledge path available again.
    render(stagedBackedComponent(true), { isFinanceOrAdmin: true });
    menu = openMenuContaining("Create standalone gift…");
    expect(menu).not.toBeNull();
    expect(
      menuItem(menu as HTMLElement, "Record as payment on pledge…")?.getAttribute("data-disabled"),
    ).toBeNull();
  });
});
