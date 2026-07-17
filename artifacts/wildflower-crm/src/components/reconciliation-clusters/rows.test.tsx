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
import { ClusterRow, type ClusterActions } from "./rows";
import { DonorActions } from "./primitives";

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
    information: { state: "incomplete", crmComplete: false, qbComplete: false },
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

  it("status cell derives word + detail from coverage.state (missing/incomplete/unlinked)", () => {
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
    expect(status!.textContent).toContain("QB not linked");
  });

  it("settlementLinkState=confirmed is omitted from the status detail", () => {
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
  });

  it("settlementLinkState=proposed_conflict shows in the status detail", () => {
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
    expect(status!.textContent).toContain("Settlement conflict");
  });

  it("settlementLinkState=proposed_full / proposed_partial show in the status detail", () => {
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

const noopToggle = () => {};
