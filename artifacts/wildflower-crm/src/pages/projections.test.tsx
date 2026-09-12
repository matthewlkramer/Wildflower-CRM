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

import Projections, { CashFlow } from "./projections";

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
    months: [],
  };

  api.monthlyLoanData = {
    category: "loan_capital",
    asOfDate: "2026-09-12",
    items: [],
    months: [],
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

function openArrivals() {
  act(() => root.render(<CashFlow />));
}
function clickButton(text: string) {
  const button = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  act(() => button!.click());
}
function filterBy(label: string, value: string) {
  act(() => {
    const select = container.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    )!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function addArrival(overrides: Record<string, unknown>) {
  (api.monthlyRevenueData!.items as Array<Record<string, unknown>>).push({
    id: "future",
    opportunityId: "future-opp",
    opportunityName: "Future gift",
    status: "open",
    expectedDate: "2027-09-01",
    amount: "700",
    weightedAmount: "350",
    basis: "projected_close",
    overdue: false,
    note: "Receipt estimate",
    ...overrides,
  });
}

describe("monthly cash outlook", () => {
  it("starts with twelve current months and keeps older, later and undated expectations separate", () => {
    addArrival({});
    openArrivals();
    const months = [
      ...container.querySelectorAll('[data-testid^="row-monthly-"]'),
    ];
    expect(months).toHaveLength(12);
    expect(months[0].textContent).toContain("Sep 2026");
    expect(months[11].textContent).toContain("Aug 2027");
    expect(
      container.querySelector('[data-testid="row-monthly-2026-08"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="arrival-group-older"]')
        ?.textContent,
    ).toContain("$1,000");
    expect(
      container.querySelector('[data-testid="arrival-group-later"]')
        ?.textContent,
    ).toContain("$350");
    expect(container.querySelector('[data-testid="arrival-close"]')).toBeNull();
    clickButton("Oct 2026");
    expect(
      container.querySelector('[data-testid="arrival-close"]')?.textContent,
    ).toContain("Projected close date");
    expect(
      container
        .querySelector('[data-testid="arrival-close"] a')
        ?.getAttribute("href"),
    ).toBe("/opportunities/opp-close#payment-plan");
    clickButton("Oct 2026");
    expect(container.querySelector('[data-testid="arrival-close"]')).toBeNull();
    clickButton("Earlier outstanding");
    expect(
      container.querySelector('[data-testid="arrival-explicit"]')?.textContent,
    ).toContain("Overdue expected payment");
    clickButton("Beyond the next");
    expect(
      container.querySelector('[data-testid="arrival-future"]'),
    ).not.toBeNull();
    clickButton("Timing not estimated");
    expect(
      container.querySelector('[data-testid="arrival-unknown"]')?.textContent,
    ).toContain("Unknown");
    clickButton("Annual reimbursement plans");
    expect(
      container.querySelector('[data-testid="arrival-annual"]')?.textContent,
    ).toContain("Not included");
    expect(
      container.querySelector(
        '[data-testid="arrival-group-annual"] table[aria-label$="totals"]',
      ),
    ).toBeNull();
    expect(container.textContent).not.toContain("Needs attention");
  });

  it("combines status and timing filters and updates the expanded details and totals together", () => {
    addArrival({
      id: "explicit-open",
      opportunityName: "Explicit prospect",
      expectedDate: "2026-10-15",
      amount: "300",
      weightedAmount: "90",
      basis: "explicit_payment",
    });
    addArrival({
      id: "explicit-pledge",
      status: "pledge",
      opportunityName: "October pledge",
      expectedDate: "2026-10-31",
      amount: "100",
      weightedAmount: "100",
      basis: "explicit_payment",
    });
    openArrivals();
    clickButton("Oct 2026");
    filterBy("Funding status", "open");
    filterBy("Timing basis", "explicit_payment");
    const month = container.querySelector(
      '[data-testid="row-monthly-2026-10"]',
    )!;
    expect(
      [...month.querySelectorAll("td")]
        .slice(1)
        .map((cell) => cell.textContent),
    ).toEqual(["$0", "$300", "$90"]);
    expect(
      container.querySelector('[data-testid="arrival-explicit-open"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="arrival-explicit-pledge"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="arrival-close"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="arrival-group-older"]'),
    ).toBeNull();
    clickButton("Clear filters");
    expect(
      [...month.querySelectorAll("td")]
        .slice(1)
        .map((cell) => cell.textContent),
    ).toEqual(["$100", "$2,300", "$1,090"]);
    expect(
      container.querySelector('[data-testid="arrival-close"]'),
    ).not.toBeNull();
  });

  it("retains unknown dated amounts and probabilities without counting annual plans as cash", () => {
    addArrival({
      id: "unknown-dated",
      expectedDate: "2026-09-30",
      amount: null,
      weightedAmount: null,
    });
    addArrival({
      id: "unknown-probability",
      expectedDate: "2026-09-30",
      amount: "500",
      weightedAmount: null,
    });
    openArrivals();
    const month = container.querySelector(
      '[data-testid="row-monthly-2026-09"]',
    )!;
    expect(month.textContent).toContain("$500");
    expect(month.textContent).toContain("Plus unknown amounts");
    clickButton("Sep 2026");
    expect(
      container.querySelector('[data-testid="arrival-unknown-dated"]')
        ?.textContent,
    ).toContain("Unknown");
    filterBy("Timing basis", "reimbursement_annual");
    expect(
      container.querySelector('[data-testid="arrival-group-annual"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="row-monthly-2026-09"]')
        ?.textContent,
    ).not.toContain("$10,000");
    expect(
      container.querySelector('[data-testid="arrival-group-undated"]'),
    ).toBeNull();
  });

  it("uses the report date across year boundaries and includes the last day of the twelfth month", () => {
    api.monthlyRevenueData!.asOfDate = "2026-12-31";
    addArrival({ id: "last-month", expectedDate: "2027-11-30" });
    addArrival({ id: "next-window", expectedDate: "2027-12-01" });
    openArrivals();
    const months = [
      ...container.querySelectorAll('[data-testid^="row-monthly-"]'),
    ];
    expect(months[0].textContent).toContain("Dec 2026");
    expect(months[11].textContent).toContain("Nov 2027");
    clickButton("Nov 2027");
    expect(
      container.querySelector('[data-testid="arrival-last-month"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="arrival-next-window"]'),
    ).toBeNull();
    clickButton("Beyond the next");
    expect(
      container.querySelector('[data-testid="arrival-next-window"]'),
    ).not.toBeNull();
  });

  it("shows an empty filtered result and keeps recipient/category scope in the request", () => {
    openArrivals();
    expect(api.monthlyCalls.at(-1)).toEqual({
      entityId: ["recipient-a"],
      category: "revenue",
    });
    filterBy("Funding status", "pledge");
    filterBy("Timing basis", "projected_close");
    expect(container.textContent).toContain(
      "No funding records match these filters.",
    );
    expect(
      container.querySelectorAll('[data-testid^="row-monthly-"]'),
    ).toHaveLength(12);
    clickButton("Loans / Loan Capital");
    expect(api.monthlyCalls.at(-1)).toEqual({
      entityId: ["recipient-a"],
      category: "loan_capital",
    });
    expect(container.textContent).not.toContain("Pipeline Gift");
  });
});
