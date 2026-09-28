import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/quickbooksOauth", () => ({
  getQuickbooksApiBase: () => "https://quickbooks.example.test",
}));

const {
  downloadQuickbooksAttachment,
  pullDepositAttachments,
  pullDepositsForAttachments,
} = await import("../lib/quickbooksClient");

describe("QuickBooks deposit attachments", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps only attachment references to deposits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          QueryResponse: {
            Attachable: [
              {
                Id: "att-1",
                FileName: "deposit.pdf",
                ContentType: "application/pdf",
                TempDownloadUri: "https://files.example.test/att-1",
                MetaData: { LastUpdatedTime: "2026-09-25T12:00:00Z" },
                AttachableRef: [
                  { EntityRef: { type: "Invoice", value: "inv-1" } },
                  { EntityRef: { type: "Deposit", value: "dep-1" } },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(pullDepositAttachments("token", "realm")).resolves.toEqual([
      {
        id: "att-1",
        depositId: "dep-1",
        fileName: "deposit.pdf",
        contentType: "application/pdf",
        note: null,
        tempDownloadUri: "https://files.example.test/att-1",
        updatedAt: "2026-09-25T12:00:00Z",
      },
    ]);
  });

  it("loads unchanged parent deposits by id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          QueryResponse: {
            Deposit: [
              {
                Id: "dep-1",
                TotalAmt: 2034.28,
                TxnDate: "2026-08-24",
                PrivateNote: "Village Montessori deposit",
                CurrencyRef: { value: "USD" },
                MetaData: { LastUpdatedTime: "2026-08-24T15:00:00Z" },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const deposits = await pullDepositsForAttachments("token", "realm", [
      "dep-1",
    ]);
    expect(deposits.get("dep-1")).toMatchObject({
      id: "dep-1",
      totalAmount: "2034.28",
      txnDate: "2026-08-24",
      privateNote: "Village Montessori deposit",
      currency: "USD",
    });
  });

  it("downloads attachment bytes with the QuickBooks token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    );

    const downloaded = await downloadQuickbooksAttachment(
      "token",
      "https://files.example.test/att-1",
    );
    expect([...downloaded.bytes]).toEqual([1, 2, 3]);
    expect(downloaded.contentType).toBe("application/pdf");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://files.example.test/att-1",
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
      }),
    );
  });
});
