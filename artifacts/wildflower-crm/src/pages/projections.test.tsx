// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentFiscalYearEndYear, currentFiscalYearSlug } from "@/lib/format";

const currentFy = currentFiscalYearSlug();
const nextFy = `fy${currentFiscalYearEndYear() + 1}`;
const api = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown> | undefined>,
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  invalidations: [] as Array<{ queryKey: unknown }>,
  toasts: [] as Array<Record<string, unknown>>,
  revenueData: null as Record<string, unknown> | null,
  loanData: null as Record<string, unknown> | null,
  monthlyCalls: [] as Array<Record<string, unknown> | undefined>,
  monthlyRevenueData: null as Record<string, unknown> | null,
  monthlyLoanData: null as Record<string, unknown> | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: async (request: { queryKey: unknown }) => {
      api.invalidations.push(request);
    },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: (request: Record<string, unknown>) => api.toasts.push(request),
  }),
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
  useUpdateOpportunityOrPledge: () => ({
    mutateAsync: async (request: {
      id: string;
      data: Record<string, unknown>;
    }) => {
      api.updates.push(request);
      return {};
    },
  }),
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
    ...(params ? [params] : []),
  ],
  getGetOpportunityOrPledgeQueryKey: (id: string) => ["opportunity", id],
  getListOpportunitiesAndPledgesQueryKey: () => ["opportunities"],
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
    weightedProjection: "3200",
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
  api.updates.length = 0;
  api.invalidations.length = 0;
  api.toasts.length = 0;
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
    items: [],
    months: [],
    rows: [
      {
        opportunityId: "opp-close",
        opportunityName: "Pipeline Gift",
        status: "open",
        stage: "warm_lead",
        askAmount: "2500",
        weighting: "0.5",
        foundationCommitted: "0",
        foundationWeightedTarget: "1000",
        regionalCommitted: "0",
        regionalWeightedTarget: "250",
        seedFundCommitted: "0",
        seedFundWeightedTarget: "125",
        total: "1375",
        hasWeightedAskMismatch: true,
        forecastDate: "2026-10-01",
        forecastBasis: "projected_close",
        projectedCloseDate: null,
        projectedCloseMonthsOut: 1,
      },
      {
        opportunityId: "opp-explicit",
        opportunityName: "Committed Pledge",
        status: "pledge",
        stage: "verbal_confirmation",
        askAmount: "1000",
        weighting: "1",
        foundationCommitted: "600",
        foundationWeightedTarget: "0",
        regionalCommitted: "200",
        regionalWeightedTarget: "0",
        seedFundCommitted: "100",
        seedFundWeightedTarget: "0",
        total: "900",
        hasWeightedAskMismatch: true,
        forecastDate: null,
        forecastBasis: null,
        projectedCloseDate: null,
        projectedCloseMonthsOut: null,
      },
    ],
  };

  api.monthlyLoanData = {
    category: "loan_capital",
    asOfDate: "2026-09-12",
    items: [],
    months: [],
    rows: [],
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
  it("shows received actuals for past years and the authoritative weighted total for current years", () => {
    render();
    const current = container.querySelector(
      `[data-testid="row-projection-${currentFy}"]`,
    );
    const historical = container.querySelector(
      '[data-testid="row-projection-fy2025"]',
    );
    expect(
      current?.querySelector('[data-testid="projection-cell-total"]')
        ?.textContent,
    ).toContain("$3,200");
    expect(current?.textContent).toContain("Received + weighted pipeline");
    expect(
      historical?.querySelector('[data-testid="projection-cell-total"]')
        ?.textContent,
    ).toContain("$1,000");
    expect(historical?.textContent).not.toContain("weighted pipeline");
    expect(historical?.textContent).not.toContain("Unpaid commitments");
  });
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

function openActions(opportunityId = "opp-close"): HTMLElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[data-testid="cash-flow-actions-${opportunityId}"]`,
  );
  expect(trigger).not.toBeNull();
  act(() =>
    trigger!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
  );
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu!;
}

function menuItem(menu: HTMLElement, label: string): HTMLElement {
  const item = Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((candidate) => candidate.textContent?.includes(label));
  expect(item, label).not.toBeNull();
  return item!;
}

function changeInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("cash-flow forecast spreadsheet", () => {
  it("renders one row per active opportunity or unpaid pledge with the requested allocation pairs", () => {
    openArrivals();
    expect(container.textContent).toContain("Wildflower Foundation");
    expect(container.textContent).toContain("Region-restricted");
    expect(container.textContent).toContain("Seed Fund");
    const prospect = container.querySelector(
      '[data-testid="cash-flow-row-opp-close"]',
    )!;
    expect(prospect.textContent).toContain("Pipeline Gift");
    expect(prospect.textContent).toContain("$2,500");
    expect(prospect.textContent).toContain("50%");
    expect(prospect.textContent).toContain("$1,375");
    expect(prospect.textContent).toContain("Oct 1, 2026");
    expect(
      prospect.querySelector('[data-testid="cash-flow-warning-opp-close"]'),
    ).not.toBeNull();
    expect(
      prospect
        .querySelector('[data-testid="cash-flow-date-opp-close"]')
        ?.classList.contains("italic"),
    ).toBe(true);
    expect(prospect.querySelector("a")?.getAttribute("href")).toBe(
      "/opportunities/opp-close",
    );
    const pledge = container.querySelector(
      '[data-testid="cash-flow-row-opp-explicit"]',
    )!;
    expect(pledge.textContent).toContain("Unpaid pledge");
    expect(pledge.textContent).toContain("100%");
    expect(pledge.textContent).toContain("$900");
    expect(container.textContent).toContain(
      "The Total column adds those six cells",
    );
  });

  it("keeps recipient and category scope in the request", () => {
    openArrivals();
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
    expect(container.textContent).toContain(
      "No active opportunities or unpaid pledges match this scope.",
    );
  });

  it("switches a row directly to a rolling six-month close", async () => {
    openArrivals();
    const menu = openActions();
    await act(async () => {
      menuItem(menu, "Switch to rolling 6 month close").click();
    });
    expect(api.updates).toContainEqual({
      id: "opp-close",
      data: { projectedCloseMonthsOut: 6 },
    });
    expect(api.invalidations).toContainEqual({
      queryKey: ["monthly-cash"],
    });
  });

  it("validates and saves a custom rolling close between 1 and 24 months", async () => {
    openArrivals();
    const menu = openActions();
    act(() => menuItem(menu, "Switch to rolling X month close").click());
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="cash-flow-months-input-opp-close"]',
    );
    expect(input).not.toBeNull();
    changeInput(input!, "25");
    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Switch to rolling close"));
    expect(save?.disabled).toBe(true);
    changeInput(input!, "4");
    expect(save?.disabled).toBe(false);
    await act(async () => save!.click());
    expect(api.updates.at(-1)).toEqual({
      id: "opp-close",
      data: { projectedCloseMonthsOut: 4 },
    });
  });

  it("sets a specific close date and records dormant and lost outcomes", async () => {
    openArrivals();
    let menu = openActions();
    act(() => menuItem(menu, "Edit close date").click());
    const dateInput =
      document.querySelector<HTMLInputElement>('input[type="date"]');
    expect(dateInput).not.toBeNull();
    changeInput(dateInput!, "2027-02-03");
    const saveDate = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent?.includes("Save close date"));
    await act(async () => saveDate!.click());
    expect(api.updates.at(-1)).toEqual({
      id: "opp-close",
      data: { projectedCloseDate: "2027-02-03" },
    });

    menu = openActions();
    act(() => menuItem(menu, "Mark dormant").click());
    const confirmDormant = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Mark dormant");
    await act(async () => confirmDormant!.click());
    expect(api.updates.at(-1)).toEqual({
      id: "opp-close",
      data: {
        lossType: "dormant",
        actualCompletionDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });

    menu = openActions();
    act(() => menuItem(menu, "Mark lost").click());
    const confirmLost = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((button) => button.textContent === "Mark lost");
    await act(async () => confirmLost!.click());
    expect(api.updates.at(-1)).toEqual({
      id: "opp-close",
      data: {
        lossType: "lost",
        actualCompletionDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
  });
});
