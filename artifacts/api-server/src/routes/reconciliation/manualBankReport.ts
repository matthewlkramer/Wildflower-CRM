import { Router, type IRouter } from "express";
import { ManualBankReportImportBody } from "@workspace/api-zod";
import { requireFinance } from "../../lib/financeGuard";
import { asyncHandler, parseOrBadRequest } from "../../lib/helpers";
import { processManualBankReportFile } from "../../lib/scheduledBankReport";

const router: IRouter = Router();

function decodeBase64(value: string): Buffer | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
  ) {
    return null;
  }
  const bytes = Buffer.from(normalized, "base64");
  return bytes.toString("base64") === normalized ? bytes : null;
}

router.post(
  "/reconciliation/bank-report-imports",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const body = parseOrBadRequest(ManualBankReportImportBody, req.body, res);
    if (!body) return;

    const bytes = decodeBase64(body.contentBase64);
    if (!bytes) {
      res.status(400).json({
        error: "invalid_report_encoding",
        message: "Report content must be valid base64.",
      });
      return;
    }

    res.json(
      await processManualBankReportFile({
        filename: body.filename,
        bytes,
      }),
    );
  }),
);

export default router;
