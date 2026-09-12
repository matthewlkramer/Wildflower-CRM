import { describe, expect, it } from "vitest";
import {
  collapsePledgePayments,
  largestGivingMetric,
} from "../lib/givingMetrics";

describe("giving relationship pledge metrics", () => {
  it("counts a pledge with multiple payments once and uses the pledge total", () => {
    const metrics = collapsePledgePayments([
      {
        id: "payment-1",
        amount: "40.00",
        dateReceived: "2026-01-02",
        opportunityId: "pledge-1",
        pledgeAmount: "100.00",
        pledgeDate: "2025-10-01",
        pledgePaymentStatus: "partially_paid",
      },
      {
        id: "payment-2",
        amount: "60.00",
        dateReceived: "2026-02-02",
        opportunityId: "pledge-1",
        pledgeAmount: "100.00",
        pledgeDate: "2025-10-01",
        pledgePaymentStatus: "paid",
      },
      {
        id: "gift-1",
        amount: "75.00",
        dateReceived: "2025-12-01",
        opportunityId: null,
        pledgeAmount: null,
        pledgeDate: null,
        pledgePaymentStatus: null,
      },
    ]);

    expect(metrics).toHaveLength(2);
    expect(largestGivingMetric(metrics)).toMatchObject({
      id: "pledge-1",
      kind: "pledge",
      amount: "100.00",
      dateReceived: "2025-10-01",
    });
  });

  it("keeps an unlinked payment as a one-time gift", () => {
    const metrics = collapsePledgePayments([
      {
        id: "gift-1",
        amount: "25.00",
        dateReceived: "2026-03-01",
        opportunityId: null,
        pledgeAmount: null,
        pledgeDate: null,
        pledgePaymentStatus: null,
      },
    ]);
    expect(metrics).toEqual([
      {
        id: "gift-1",
        amount: "25.00",
        dateReceived: "2026-03-01",
        kind: "gift",
      },
    ]);
  });
});