// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentFiscalYearEndYear, currentFiscalYearSlug } from "@/lib/format";

const currentFy = currentFiscalYearSlug();
const nextFy = `fy${currentFiscalYearEndYear() + 1}`;
const api = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown> | undefined>,
  revenueData: null as Record<string, unknown> | null,
  loanData: null as Record<string, unknown> | null,
  monthlyCalls: [] as Array<Record<string, unknown> | undefined>,
  monthlyRevenueData: null as Record<string, unknown> | null,
  monthlyLoanData: null as Record<string, unknown> | null,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetProjectionsByFyEntity: (
    params: Record<string, unknown> | undefined,
  ) => {
    api.calls.push(params);
    return {
      data:
        params?.category === "loan_capital" ? api.loanData : api.revenueData,
      isLoading: false,
      isError: false,
      error: null,
    };
  },
  useGetFundingArrivalsByMonth: (
    params: Record<string, unknown> | undefined,
  ) => {
    api.monthlyCalls.push(params);
    return {
      data:
        params?.category === "loan_capital"
          ? api.monthlyLoanData
          : api.monthlyRevenueData,
      isLoading: false,
      isError: false,
      error: null,
    };
  },
  useListEntities: () => ({
    data: [{ id: "recipient-a", name: "Recipient A" }],
  }),
  useListFiscalYears: () => ({
    data: [
      { id: currentFy, label: "Current fiscal year" },
      { id: nextFy, label: "Next fiscal year" },
      { id: "fy2025", label: "FY 2025" },
    ],
  }),
  getGetProjectionsByFyEntityQueryKey: (params: unknown) => [
    "projections",
    params,
  ],
  getGetFundingArrivalsByMonthQueryKey: (params: unknown) => [
    "monthly-cash",
    params,
  ],
  getListEntitiesQueryKey: () => ["entities"],
  getListFiscalYearsQueryKey: () => ["fiscal-years"],
}));

vi.mock("@/lib/entity-filter-context", () => ({
  useEntityFilter: () => ({ selected: ["recipient-a"] }),
}));

import Projections from "./projections";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function row(grantYear: string | null, entityId: string | null) {
  return {
    grantYear,
    entityId,
    category: "revenue",
    allocationCount: 1,
    totalSubAmount: "700",
    expected: "700",
    receivedGoalCredit: "1000",
    unpaidCommitment: "2500",
    unpaidCommitmentWeighted: "1500",
    openAsk: "900",
    openAskWeighted: "700",
    goal: "5000",
    goalGap: "1800",
  };
}

const revenueDiagnostics = [
  {
    opportunityId: "needs-review",
    opportunityName: "Needs recipient",
    grantYear: currentFy,
    entityId: null,
    reasons: ["missing_recipient", "missing_amount"],
    message: "Assign a recipient before forecasting this opportunity.",
  },
  {
    opportunityId: "unused-capacity",
    opportunityName: "Unused capacity",
    grantYear: currentFy,
    entityId: "recipient-a",
    reasons: ["unused_capacity"],
    message:
      "Cost-reimbursement award has unused capacity; no drawdown plan is recorded.",
  },
  {
    opportunityId: "direct-reimbursement",
    opportunityName: "Direct reimbursement",
    grantYear: currentFy,
    entityId: "recipient-a",
    reasons: ["direct_reimbursement_excluded"],
    message: null,
  },
  {
    opportunityId: "zero-probability",
    opportunityName: "Early prospect",
    grantYear: currentFy,
    entityId: "recipient-a",
    reasons: ["zero_weight_early_prospect"],
    message: null,
  },
];

beforeEach(() => {
  api.calls.length = 0;
  api.monthlyCalls.length = 0;
  api.revenueData = {
    rows: [
      row(currentFy, "recipient-a"),
      row(nextFy, "recipient-a"),
      row("fy2025", null),
      row(null, null),
    ],
    combinedRows: [
      {
        grantYear: currentFy,
        category: "revenue",
        totalSubAmount: "900",
        expected: "700",
        receivedGoalCredit: "1000",
        unpaidCommitment: "2500",
        unpaidCommitmentWeighted: "1500",
        openAsk: "900",
        openAskWeighted: "700",
        weightedProjection: "3200",
        goal: "5000",
        goalGap: "1800",
      },
    ],
    diagnostics: revenueDiagnostics,
  };
  api.loanData = {
    rows: [],
    combinedRows: [],
    diagnostics: [
      {
        opportunityId: "loan-only",
        opportunityName: "Loan-only detail",
        reasons: ["missing_amount"],
        message: "Loan amount is missing.",
      },
    ],
  };

  api.monthlyRevenueData = {
    category: "revenue",
    asOfDate: "2026-09-12",
    items: [
      {
        id: "close",
        opportunityId: "opp-close",
        opportunityName: "Pipeline Gift",
        status: "open",
        expectedDate: "2026-10-01",
        amount: "2000",
        weightedAmount: "1000",
        basis: "projected_close",
        overdue: false,
        note: "Estimated from close date.",
      },
      {
        id: "explicit",
        opportunityId: "opp-explicit",
        opportunityName: "Committed Pledge",
        status: "pledge",
        expectedDate: "2026-08-01",
        amount: "1000",
        weightedAmount: "1000",
        basis: "explicit_payment",
        overdue: true,
        note: "Recorded payment plan.",
      },
      {
        id: "unknown",
        opportunityId: "opp-unknown",
        opportunityName: "Untimed Pledge",
        status: "pledge",
        expectedDate: null,
        amount: null,
        weightedAmount: null,
        basis: "unscheduled",
        overdue: false,
        note: "No timing estimate recorded.",
      },
      {
        id: "annual",
        opportunityId: "opp-reimb",
        opportunityName: "Reimbursement",
        status: "pledge",
        expectedDate: null,
        amount: "10000",
        weightedAmount: null,
        basis: "reimbursement_annual",
        overdue: false,
        note: "Annual plan context only.",
      },
    ],
    months: [
      {
        month: "2024-01",
        committedAmount: "1000",
        prospectiveAmount: "2000",
        prospectiveWeightedAmount: "1000",
        sourceRecordIds: ["a", "b"],
      },
    ],
    unknownTiming: [
      {
        category: "revenue",
        status: "open",
        opportunityId: "opp-unknown",
        opportunityName: "Unknown Opp",
        amount: "5000",
        remainingAmount: "5000",
        sourceRecordIds: ["c"],
        message: "No payment dates.",
      },
    ],
    actionableItems: [
      {
        type: "missing_amount",
        category: "revenue",
        opportunityId: "opp-action",
        opportunityName: "Action Opp",
        amount: "0",
        remainingAmount: "0",
        sourceRecordIds: ["d"],
        message: "Missing amount in schedule.",
      },
    ],
    untimedReimbursementPlans: [
      {
        opportunityId: "opp-reimb",
        opportunityName: "Reimb Opp",
        allocationId: "alloc-1",
        entityId: "recipient-a",
        amount: "10000",
        sourceRecordIds: ["e"],
      },
    ],
  };

  api.monthlyLoanData = {
    category: "loan_capital",
    asOfDate: "2026-09-12",
    items: [],
    months: [],
    unknownTiming: [],
    actionableItems: [],
    untimedReimbursementPlans: [],
  };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => root.render(<Projections />));
}

describe("projections forecast distinctions", () => {
  it("shows authoritative total components, face value, and separated diagnostics", () => {
    render();

    expect(container.textContent).toContain("Total forecast");
    expect(container.textContent).toContain("$3,200");
    expect(container.textContent).toContain("Received goal credit");
    expect(container.textContent).toContain("Face-value unpaid commitments");
    expect(container.textContent).toContain(
      "Probability-weighted unpaid commitments",
    );
    expect(container.textContent).toContain("Probability-weighted open asks");
    expect(
      container.querySelector('[data-testid="projection-needs-attention"]')
        ?.textContent,
    ).toContain("Assign a recipient before forecasting this opportunity.");
    expect(
      container.querySelector('[data-testid="projection-needs-attention"]')
        ?.textContent,
    ).toContain("Amount is missing");
    expect(
      container.querySelector('[data-testid="projection-needs-attention"]')
        ?.textContent,
    ).toContain("Recipient is missing");
    expect(
      container.querySelector('[data-testid="projection-information"]')
        ?.textContent,
    ).toContain(
      "Cost-reimbursement award has unused capacity; no drawdown plan is recorded.",
    );
    expect(
      container.querySelector('[data-testid="projection-information"]')
        ?.textContent,
    ).toContain("Cost-reimbursement unused capacity");
    expect(
      container.querySelector('[data-testid="projection-information"]')
        ?.textContent,
    ).toContain("Direct reimbursement is excluded from the forecast");
    const directInformation = [
      ...container.querySelectorAll(
        '[data-testid="projection-information"] li',
      ),
    ].find((item) => item.textContent?.includes("Direct reimbursement"));
    expect(directInformation?.textContent).not.toContain(
      "Cost-reimbursement unused capacity",
    );
    expect(
      container.querySelector('[data-testid="projection-information"]')
        ?.textContent,
    ).toContain("Early prospect has zero probability");
    expect(container.textContent).toContain(
      "unknown recipient can still count in the all-recipients total",
    );
    expect(container.textContent).toContain(
      "Recipient comparisons are useful for context",
    );
    expect(container.textContent).not.toContain("every record is excluded");
    expect(
      [...container.querySelectorAll('[data-testid^="row-projection-"]')].map(
        (element) => element.textContent,
      ),
    ).toEqual([
      expect.stringContaining("Current fiscal year"),
      expect.stringContaining("Next fiscal year"),
      expect.stringContaining("FY 2025"),
      expect.stringContaining("Unknown fiscal year"),
    ]);
  });

  it("uses the server-owned aggregate instead of summing rounded components", () => {
    const combinedRow = (
      api.revenueData as {
        combinedRows: Array<Record<string, string | null>>;
      }
    ).combinedRows[0];
    combinedRow.receivedGoalCredit = "0";
    combinedRow.unpaidCommitmentWeighted = "0.006";
    combinedRow.openAskWeighted = "0.006";
    combinedRow.weightedProjection = "0.012";

    render();

    expect(
      container.querySelector('[data-testid="projection-total-amount"]')
        ?.textContent,
    ).toContain("$0.01");
    expect(
      container.querySelector('[data-testid="projection-total-amount"]')
        ?.textContent,
    ).not.toContain("$0.02");
  });

  it("sends the active category with the recipient scope and renders only that response", () => {
    render();
    expect(api.calls.at(-1)).toEqual({
      entityId: ["recipient-a"],
      category: "revenue",
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="projections-category-loan_capital"]',
        )!
        .click();
    });

    expect(api.calls.at(-1)).toEqual({
      entityId: ["recipient-a"],
      category: "loan_capital",
    });
    expect(container.textContent).toContain("Loan-only detail");
    expect(container.textContent).not.toContain("Needs recipient");
    expect(container.textContent).not.toContain("Unused capacity");
  });
});

describe("monthly cash outlook", () => {
  it("renders the table, unknown timing, actionable items, and reimbursement plans", () => {
    render();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="projection-view-arrivals"]',
        )!
        .click(),
    );

    expect(container.textContent).toContain("Expected funding arrivals");
    expect(container.textContent).toContain("Jan 2024");
    expect(container.textContent).toContain("$1,000"); // committed
    expect(container.textContent).toContain("$2,000"); // prospective

    // Check unknown
    expect(container.textContent).toContain("Timing not estimated");
    expect(container.textContent).toContain("Untimed Pledge");
    expect(container.textContent).toContain("No timing estimate recorded.");

    // Check actionable
    expect(container.textContent).not.toContain("Needs attention");
    expect(container.textContent).toContain("Timing basis");
    expect(container.textContent).toContain("Projected close date");
    expect(container.textContent).toContain("Explicit payment date");
    expect(container.textContent).toContain("Overdue expected payment");
    expect(
      container.querySelector('[data-testid="arrival-unknown"]')!.textContent,
    ).toContain("Unknown");
    const editLinks = container.querySelectorAll('a[href^="/opportunities/"]');
    expect(editLinks.length).toBeGreaterThan(0);
    expect(editLinks[0].getAttribute("href")).toContain("#payment-plan");

    // Check reimbursement
    expect(container.textContent).toContain("Annual reimbursement plan");
    expect(container.textContent).toContain("Reimbursement");
    expect(container.textContent).toContain("Not included");
  });

  it("sends request params and refetches on category switch", () => {
    render();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="projection-view-arrivals"]',
        )!
        .click(),
    );
    expect(api.monthlyCalls.at(-1)).toEqual({
      entityId: ["recipient-a"],
      category: "revenue",
    });

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="projections-category-loan_capital"]',
        )!
        .click();
    });

    expect(api.monthlyCalls.at(-1)).toEqual({
      entityId: ["recipient-a"],
      category: "loan_capital",
    });
    // Loan data is empty, table should show no data message
    expect(container.textContent).toContain("No dated amounts are available");
  });
});
