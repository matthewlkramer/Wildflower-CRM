import { describe, expect, it } from "vitest";
import { manualBankReportImportId } from "./scheduledBankReport";

describe("manual bank report receipt identity", () => {
  it("is stable for identical file content and changes with the content", () => {
    const first = Buffer.from("same QuickBooks report");
    const second = Buffer.from("different QuickBooks report");

    expect(manualBankReportImportId(first)).toBe(manualBankReportImportId(first));
    expect(manualBankReportImportId(first)).not.toBe(
      manualBankReportImportId(second),
    );
    expect(manualBankReportImportId(first)).toMatch(
      /^bti_manual_[a-f0-9]{24}$/,
    );
  });
});
