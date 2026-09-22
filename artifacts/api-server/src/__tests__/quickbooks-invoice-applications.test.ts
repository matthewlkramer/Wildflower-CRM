import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullIncomingPayments } from "../lib/quickbooksClient";

beforeEach(() => {
  process.env["QUICKBOOKS_API_BASE"] = "https://qb.test.invalid";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["QUICKBOOKS_API_BASE"];
});

describe("pullIncomingPayments invoice applications", () => {
  it("preserves invoice purpose and applied amount on a receivable payment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const query = decodeURIComponent(
          new URL(String(input)).searchParams.get("query") ?? "",
        );
        let body: Record<string, unknown> = {};
        if (/FROM Payment\b/i.test(query)) {
          body = {
            Payment: [
              {
                Id: "P1",
                TotalAmt: 150,
                TxnDate: "2026-09-22",
                CustomerRef: { value: "C1", name: "Sunflower School" },
                Line: [
                  {
                    Amount: 100,
                    LinkedTxn: [{ TxnType: "Invoice", TxnId: "I1" }],
                  },
                ],
              },
            ],
          };
        } else if (/FROM Deposit\b/i.test(query)) {
          body = {
            Deposit: [
              {
                Id: "D1",
                TotalAmt: 150,
                TxnDate: "2026-09-22",
                Line: [
                  {
                    Id: "DL1",
                    Amount: 150,
                    Description: "Accounts Receivalbe batch",
                    LinkedTxn: [{ TxnType: "Payment", TxnId: "P1" }],
                  },
                ],
              },
            ],
          };
        } else if (/FROM Invoice\b/i.test(query)) {
          body = {
            Invoice: [
              {
                Id: "I1",
                DocNumber: "INV-1042",
                TotalAmt: 100,
                CustomerMemo: { value: "September membership dues" },
                Line: [
                  {
                    Amount: 100,
                    Description: "Monthly membership",
                    SalesItemLineDetail: {
                      ItemRef: { value: "ITEM1", name: "School Contributions" },
                    },
                  },
                ],
              },
            ],
          };
        } else if (/FROM Item\b/i.test(query)) {
          body = {
            Item: [
              {
                Id: "ITEM1",
                IncomeAccountRef: { name: "Membership revenue" },
              },
            ],
          };
        }
        return new Response(JSON.stringify({ QueryResponse: body }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const rows = await pullIncomingPayments("token", "realm", null);
    const payment = rows.find((row) => row.qbEntityType === "payment");

    expect(payment?.qbDepositId).toBe("D1");
    expect(payment?.lineDescription).toBe("Accounts Receivalbe batch");
    expect(payment?.qbInvoiceApplications).toEqual([
      {
        invoiceId: "I1",
        invoiceDocNumber: "INV-1042",
        invoiceTotal: "100.00",
        appliedAmount: "100.00",
        purpose: "September membership dues",
        lineItemNames: ["School Contributions"],
        lineAccountNames: ["Membership revenue"],
        lineDescriptions: ["Monthly membership"],
      },
    ]);
  });
});
