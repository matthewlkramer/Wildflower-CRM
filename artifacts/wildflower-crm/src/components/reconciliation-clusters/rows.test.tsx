// Render tests for the workbench cluster rows — the canonical-state display
// path (coverage.state → status cell), the settlement-gap card menu, and the
// identified-donor gating on DonorActions. These are jsdom render tests (no
// browser): they assert the DOM the components produce for fixture clusters,
// NOT the server derivation (that lives in the api-server integration suite).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkbenchCluster } from "@workspace/api-client-react";
import { ListWorkbenchClustersResponse } from "@workspace/api-zod";
import { ClusterRow, giftUnlinkOptions, type ClusterActions } from "./rows";
import { DonorActions } from "./primitives";
import { UnlinkChooserDialog, type UnlinkOption } from "./dialogs";

// Contract guard: fixtures are parsed through the generated Zod schema for a
// workbench-cluster list item, so a spec/codegen change that renames or
// removes a field fails these tests loudly instead of letting stale fixtures
// keep passing against a shape the server no longer produces.
const ClusterItemSchema = ListWorkbenchClustersResponse.shape.data.element;

// Tell React this is an act()-aware test environment.
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

function render(el: React.ReactElement) {
  act(() => root.render(el));
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

function allByTestIdPrefix(prefix: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(`[data-testid^="${prefix}"]`));
}

function makeActions(): ClusterActions {
  return {
    busy: false,
    openLinkGift: vi.fn(),
    openCreateGift: vi.fn(),
    openIdentify: vi.fn(),
    openExclude: vi.fn(),
    reInclude: vi.fn(),
    openRevert: vi.fn(),
    openConfirmRefund: vi.fn(),
    openDismissRefund: vi.fn(),
    openFlag: vi.fn(),
    openFlagGift: vi.fn(),
    openMarkLoss: vi.fn(),
    openSettlementSearch: vi.fn(),
    isFinanceOrAdmin: false,
    openQbDetail: vi.fn(),
    removeSettlementProposal: vi.fn(),
    revertSettlement: vi.fn(),
    rejectChargeQbTie: vi.fn(),
    openUnlinkChooser: vi.fn(),
  };
}

/** Pairwise linkage edge as it appears on the wire (state + grain + count). */
function makeLinkEdge(state: string) {
  return { state, grain: "none", relationshipCount: 0 };
}

/** Canonical WorkbenchRowState fixture (docs/workbench-business-rules.md §10). */
function makeState(over: Record<string, unknown> = {}) {
  return {
    linkage: {
      state: "missing",
      accountingToTransaction: makeLinkEdge("missing"),
      transactionToCrm: makeLinkEdge("missing"),
      accountingToCrm: makeLinkEdge("missing"),
    },
    information: {
      state: "incomplete",
      crmComplete: false,
      qbComplete: false,
      qbEvidenceComplete: false,
    },
    flags: { excluded: false, conflict: false, attentionRequired: false },
    settlementLinkState: "unlinked",
    qbCards: [],
    transactions: [],
    crmCards: [],
    ...over,
  };
}

function makeCharge(over: Record<string, unknown> = {}) {
  return {
    chargeId: "ch_1",
    status: "pending",
    grossAmount: "100.00",
    feeAmount: "3.20",
    netAmount: "96.80",
    payerName: "Test Payer",
    payerEmail: null,
    dateReceived: "2099-01-01",
    linkedGiftId: null,
    refundProposed: false,
    attributedDonor: null,
    ...over,
  };
}

function makePayoutCluster(opts: {
  charges: Array<Record<string, unknown>>;
  state?: Record<string, unknown>;
  qbRecords?: Array<Record<string, unknown>>;
}): WorkbenchCluster {
  return ClusterItemSchema.parse({
    id: "stripe_payout:po_1",
    kind: "stripe_payout",
    anchorId: "po_1",
    title: "Test Payer",
    status: "unresolved",
    statusDetail: null,
    lenses: [],
    gifts: [],
    charges: opts.charges,
    qbRecords: opts.qbRecords ?? [],
    chargeCount: opts.charges.length,
    grossTotal: "100.00",
    feeTotal: "3.20",
    netTotal: "96.80",
    gapAmount: null,
    bankAmount: null,
    date: "2099-01-01",
    resolvedCount: 0,
    totalCount: opts.charges.length,
    coverage: {
      complete: false,
      donorPurpose: {
        crmLinkage: {
          grain: "none",
          complete: false,
          coveredIds: [],
          uncoveredIds: opts.charges.map((c) => c.chargeId),
        },
        crmRecordCompleteness: {
          complete: false,
          completeGiftIds: [],
          incompleteGiftIds: [],
          reasonsByGift: [],
        },
        complete: false,
      },
      paymentTransaction: {
        complete: false,
        grain: "none",
        coveredIds: [],
        uncoveredIds: [],
      },
      accountingEvidence: {
        grain: "none",
        complete: false,
        coveredIds: [],
        uncoveredIds: [],
      },
      evidenceRecords: [],
      state: opts.state ?? makeState(),
    },
  }) as unknown as WorkbenchCluster;
}

const IDENTIFIED_DONOR = {
  donorKind: "person",
  donorId: "p_1",
  donorName: "Jane Donor",
};

describe("DonorActions identified gating", () => {
  const noop = () => {};

  it("unidentified: Link is first and the third action reads 'Identify donor'", () => {
    render(
      <DonorActions
        onLink={noop}
        onCreate={noop}
        onIdentify={noop}
        testIdBase="donor-slot-x"
      />,
    );
    const buttons = allByTestIdPrefix("button-donor-slot-x-");
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "button-donor-slot-x-link",
      "button-donor-slot-x-create",
      "button-donor-slot-x-identify",
    ]);
    expect(buttons[2]?.textContent).toContain("Identify donor");
    expect(container.textContent).not.toContain("Change identified donor");
  });

  it("identified: Create becomes primary and Identify reads 'Change identified donor'", () => {
    render(
      <DonorActions
        onLink={noop}
        onCreate={noop}
        onIdentify={noop}
        identified
        testIdBase="donor-slot-x"
      />,
    );
    const buttons = allByTestIdPrefix("button-donor-slot-x-");
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "button-donor-slot-x-create",
      "button-donor-slot-x-link",
      "button-donor-slot-x-identify",
    ]);
    expect(buttons[2]?.textContent).toContain("Change identified donor");
  });
});

describe("single-charge payout row (canonical state display)", () => {
  it("no QB deposit → cardless gap slot renders with the settlement ⋯ menu trigger", () => {
    const cluster = makePayoutCluster({ charges: [makeCharge()] });
    render(
      <ClusterRow
        cluster={cluster}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    expect(container.textContent).toContain("No QB deposit linked yet");
    expect(container.textContent).toContain("settlement link missing");
    expect(byTestId("button-settlement-menu-stripe_payout:po_1")).toBeTruthy();
  });

  it("status cell is two-signal: linkage + information only, never settlement", () => {
    const cluster = makePayoutCluster({ charges: [makeCharge()] });
    render(
      <ClusterRow
        cluster={cluster}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    const status = byTestId("status-cluster-stripe_payout:po_1");
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("No linkage");
    expect(status!.textContent).toContain("Record incomplete");
    // Settlement moved out of the status cell into the accounting column.
    expect(status!.textContent).not.toContain("QB not linked");
    // unlinked + no QB records → chip suppressed (the gap slot already says it).
    expect(byTestId("settlement-chip-stripe_payout:po_1")).toBeNull();
  });

  it("settlementLinkState=confirmed never appears in the status cell", () => {
    const cluster = makePayoutCluster({
      charges: [makeCharge()],
      state: makeState({
        linkage: {
          state: "complete",
          accountingToTransaction: makeLinkEdge("complete"),
          transactionToCrm: makeLinkEdge("complete"),
          accountingToCrm: makeLinkEdge("complete"),
        },
        information: {
          state: "audit_ready",
          crmComplete: true,
          qbComplete: true,
          qbEvidenceComplete: true,
        },
        settlementLinkState: "confirmed",
      }),
    });
    render(
      <ClusterRow
        cluster={cluster}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    const status = byTestId("status-cluster-stripe_payout:po_1");
    expect(status!.textContent).toContain("Linked");
    expect(status!.textContent).not.toContain("Settlement confirmed");
    // The chip in the accounting column carries the settlement word instead.
    const chip = byTestId("settlement-chip-stripe_payout:po_1");
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain("Settlement confirmed");
  });

  it("settlementLinkState=proposed_conflict renders as a chip in the accounting column, not in status", () => {
    const cluster = makePayoutCluster({
      charges: [makeCharge()],
      state: makeState({ settlementLinkState: "proposed_conflict" }),
    });
    render(
      <ClusterRow
        cluster={cluster}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    const status = byTestId("status-cluster-stripe_payout:po_1");
    expect(status!.textContent).not.toContain("Settlement conflict");
    expect(
      byTestId("settlement-chip-stripe_payout:po_1")!.textContent,
    ).toContain("Settlement conflict");
  });

  it("settlementLinkState=proposed_full / proposed_partial render as accounting chips, not status", () => {
    const full = makePayoutCluster({
      charges: [makeCharge()],
      state: makeState({ settlementLinkState: "proposed_full" }),
    });
    render(
      <ClusterRow
        cluster={full}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    expect(
      byTestId("status-cluster-stripe_payout:po_1")!.textContent,
    ).not.toContain("Settlement proposed");
    expect(
      byTestId("settlement-chip-stripe_payout:po_1")!.textContent,
    ).toContain("Settlement proposed");

    const partial = makePayoutCluster({
      charges: [makeCharge()],
      state: makeState({ settlementLinkState: "proposed_partial" }),
    });
    render(
      <ClusterRow
        cluster={partial}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    expect(
      byTestId("status-cluster-stripe_payout:po_1")!.textContent,
    ).not.toContain("Partial settlement");
    expect(
      byTestId("settlement-chip-stripe_payout:po_1")!.textContent,
    ).toContain("Partial settlement");
  });

  it("unidentified charge → 'Identify donor' next step; identified → 'Create gift'", () => {
    const unidentified = makePayoutCluster({ charges: [makeCharge()] });
    render(
      <ClusterRow
        cluster={unidentified}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    expect(byTestId("button-status-identify-stripe_payout:po_1")).toBeTruthy();
    expect(byTestId("button-status-create-stripe_payout:po_1")).toBeNull();

    const identified = makePayoutCluster({
      charges: [makeCharge({ attributedDonor: IDENTIFIED_DONOR })],
    });
    render(
      <ClusterRow
        cluster={identified}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    expect(byTestId("button-status-create-stripe_payout:po_1")).toBeTruthy();
    expect(byTestId("button-status-identify-stripe_payout:po_1")).toBeNull();
    // Identified note + create-first donor actions on the row itself.
    expect(container.textContent).toContain("Identified:");
    expect(container.textContent).toContain("Jane Donor");
    const donorButtons = allByTestIdPrefix("button-donor-slot-ch_1-");
    expect(donorButtons[0]?.getAttribute("data-testid")).toBe(
      "button-donor-slot-ch_1-create",
    );
  });
});

describe("expanded multi-charge bundle (child-row identified gating)", () => {
  it("each child row gates DonorActions on ITS charge's attributedDonor", () => {
    const cluster = makePayoutCluster({
      charges: [
        makeCharge({ chargeId: "ch_a" }),
        makeCharge({
          chargeId: "ch_b",
          attributedDonor: IDENTIFIED_DONOR,
        }),
      ],
    });
    render(
      <ClusterRow
        cluster={cluster}
        expanded={true}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    expect(byTestId("cluster-charge-row-ch_a")).toBeTruthy();
    expect(byTestId("cluster-charge-row-ch_b")).toBeTruthy();

    // Unidentified child: link-first ordering, no identified note in its slot.
    const aButtons = allByTestIdPrefix("button-donor-slot-ch_a-");
    expect(aButtons[0]?.getAttribute("data-testid")).toBe(
      "button-donor-slot-ch_a-link",
    );

    // Identified child: create-first ordering.
    const bButtons = allByTestIdPrefix("button-donor-slot-ch_b-");
    expect(bButtons[0]?.getAttribute("data-testid")).toBe(
      "button-donor-slot-ch_b-create",
    );
    expect(container.textContent).toContain("Jane Donor");

    // Child status stays charge-grain: unmatched charge reads "Missing donor".
    expect(byTestId("status-charge-ch_a")!.textContent).toContain(
      "Missing donor",
    );
  });
});

function makeGift(over: Record<string, unknown> = {}) {
  return {
    giftId: "g_1",
    opportunityId: null,
    name: "Jane Donor gift",
    donorName: "Jane Donor",
    donorKind: "person",
    donorId: "p_1",
    amount: "100.00",
    dateReceived: "2099-01-02",
    quickbooksTie: "exempt",
    linkedChargeIds: [],
    linkedStagedPaymentIds: [],
    ...over,
  };
}

function makeCrmOnlyCluster(): WorkbenchCluster {
  return ClusterItemSchema.parse({
    id: "crm_only:g_1",
    kind: "crm_only",
    anchorId: "g_1",
    title: "Jane Donor gift",
    status: "unresolved",
    statusDetail: null,
    lenses: [],
    gifts: [makeGift()],
    charges: [],
    qbRecords: [],
    chargeCount: 0,
    grossTotal: null,
    feeTotal: null,
    netTotal: null,
    gapAmount: null,
    bankAmount: null,
    date: "2099-01-02",
    resolvedCount: null,
    totalCount: null,
    coverage: {
      complete: false,
      donorPurpose: {
        crmLinkage: {
          grain: "none",
          complete: false,
          coveredIds: [],
          uncoveredIds: [],
        },
        crmRecordCompleteness: {
          complete: false,
          completeGiftIds: [],
          incompleteGiftIds: ["g_1"],
          reasonsByGift: [],
        },
        complete: false,
      },
      paymentTransaction: {
        complete: false,
        grain: "none",
        coveredIds: [],
        uncoveredIds: [],
      },
      accountingEvidence: {
        grain: "none",
        complete: false,
        coveredIds: [],
        uncoveredIds: [],
      },
      evidenceRecords: [],
      state: makeState({ settlementLinkState: null }),
    },
  }) as unknown as WorkbenchCluster;
}

describe("CRM-only row grid completeness", () => {
  it("renders explicit empty transaction + accounting slots so the row fills all six grid columns", () => {
    render(
      <ClusterRow
        cluster={makeCrmOnlyCluster()}
        expanded={false}
        onToggle={noopToggle}
        actions={makeActions()}
      />,
    );
    const row = byTestId("cluster-row-crm_only:g_1");
    expect(row).toBeTruthy();
    // Six direct grid children: chevron, gifts, txn slot, accounting slot, status, kebab.
    expect(row!.children.length).toBe(6);
    const txnSlot = byTestId("crm-only-transaction-slot-crm_only:g_1");
    const qbSlot = byTestId("crm-only-accounting-slot-crm_only:g_1");
    expect(txnSlot!.textContent).toContain("No payment evidence linked yet");
    expect(qbSlot!.textContent).toContain("No accounting record linked yet");
    expect(byTestId("status-cluster-crm_only:g_1")).toBeTruthy();
  });
});

describe("giftUnlinkOptions (relationship-specific unlink)", () => {
  it("returns one option per linked evidence record, enriched from the cluster lists", () => {
    const cluster = makePayoutCluster({
      charges: [
        makeCharge({ chargeId: "ch_a", payerName: "Alice", grossAmount: "40.00" }),
        makeCharge({ chargeId: "ch_b", payerName: "Bob", grossAmount: "60.00" }),
      ],
    });
    const gift = makeGift({
      linkedChargeIds: ["ch_a", "ch_b"],
      linkedStagedPaymentIds: ["sp_z"],
    }) as unknown as WorkbenchCluster["gifts"][number];
    const options = giftUnlinkOptions(gift, cluster);
    expect(options).toHaveLength(3);
    expect(options[0].anchor).toEqual({
      kind: "charge",
      id: "ch_a",
      label: "Jane Donor gift",
    });
    expect(options[0].source).toContain("Stripe charge");
    expect(options[0].source).toContain("Alice");
    expect(options[1].source).toContain("Bob");
    // Evidence missing from the (capped) cluster lists falls back to an id label.
    expect(options[2].anchor.kind).toBe("staged");
    expect(options[2].source).toContain("sp_z");
    expect(options[2].amount).toBeNull();
  });

  it("routes the gift menu: multiple links → chooser payload, single link → direct anchor", () => {
    const multi = makeGift({
      linkedChargeIds: ["ch_a", "ch_b"],
    }) as unknown as WorkbenchCluster["gifts"][number];
    const single = makeGift({
      linkedChargeIds: ["ch_a"],
    }) as unknown as WorkbenchCluster["gifts"][number];
    const cluster = makePayoutCluster({
      charges: [makeCharge({ chargeId: "ch_a" }), makeCharge({ chargeId: "ch_b" })],
    });
    expect(giftUnlinkOptions(multi, cluster)).toHaveLength(2);
    expect(giftUnlinkOptions(single, cluster)).toHaveLength(1);
    expect(giftUnlinkOptions(single, cluster)[0].anchor.id).toBe("ch_a");
  });
});

describe("UnlinkChooserDialog", () => {
  const OPTIONS: UnlinkOption[] = [
    {
      anchor: { kind: "charge", id: "ch_a", label: "Jane Donor gift" },
      source: "Stripe charge · Alice",
      amount: "$40.00",
      date: "Jan 1, 2099",
    },
    {
      anchor: { kind: "staged", id: "sp_z", label: "Jane Donor gift" },
      source: "QuickBooks · Deposit",
      amount: "$60.00",
      date: "Jan 2, 2099",
    },
  ];

  function byBodyTestId(id: string): HTMLElement | null {
    return document.body.querySelector(`[data-testid="${id}"]`);
  }

  it("lists every relationship, disables continue until one is picked, then returns the picked option", () => {
    const onPick = vi.fn();
    render(
      <UnlinkChooserDialog
        open
        onOpenChange={() => {}}
        giftLabel="Jane Donor gift"
        options={OPTIONS}
        busy={false}
        onPick={onPick}
      />,
    );
    // Dialog renders in a portal — query the document body.
    expect(byBodyTestId("radio-unlink-ch_a")).toBeTruthy();
    expect(byBodyTestId("radio-unlink-sp_z")).toBeTruthy();
    expect(document.body.textContent).toContain("Stripe charge · Alice");
    expect(document.body.textContent).toContain("QuickBooks · Deposit");
    expect(document.body.textContent).toContain("$40.00");

    const cont = byBodyTestId("button-unlink-chooser-continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);

    act(() => {
      (byBodyTestId("radio-unlink-sp_z") as HTMLButtonElement).click();
    });
    expect(cont.disabled).toBe(false);

    act(() => cont.click());
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].anchor).toEqual({
      kind: "staged",
      id: "sp_z",
      label: "Jane Donor gift",
    });
  });
});

const noopToggle = () => {};
