import { logger } from "./logger";

const DEFAULT_MODEL = "gpt-5-mini";
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type ExtractedDepositComponent = {
  amount: string;
  payerName: string | null;
  checkNumber: string | null;
  reference: string | null;
};

function parseAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).replace(/[$,\s]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : null;
}

/**
 * Accept extracted evidence only when it is a real decomposition: at least two
 * positive components whose cent-rounded sum exactly equals the bank deposit.
 */
export function validateAttachmentComposition(
  depositTotal: string | number,
  input: unknown,
): ExtractedDepositComponent[] | null {
  const total = parseAmount(depositTotal);
  if (total === null || !Array.isArray(input)) return null;
  const components: ExtractedDepositComponent[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const amount = parseAmount(value.amount);
    if (amount === null) return null;
    components.push({
      amount: amount.toFixed(2),
      payerName: optionalText(value.payerName),
      checkNumber: optionalText(value.checkNumber),
      reference: optionalText(value.reference),
    });
  }
  if (components.length < 2) return null;
  const componentCents = components.reduce(
    (sum, component) => sum + Math.round(Number(component.amount) * 100),
    0,
  );
  return componentCents === Math.round(total * 100) ? components : null;
}

function config() {
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  const baseURL = (
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  if (!apiKey) throw new Error("OpenAI is not configured.");
  return { apiKey, baseURL };
}

function outputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  if (typeof value.output_text === "string") return value.output_text.trim();
  if (!Array.isArray(value.output)) return "";
  const chunks: string[] = [];
  for (const item of value.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("\n").trim();
}

function parseJson(raw: string): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function extractDepositAttachmentComposition(args: {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  depositTotal: string;
}): Promise<ExtractedDepositComponent[] | null> {
  if (args.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error("QuickBooks attachment is larger than 20 MB.");
  }
  const supportedImage = /^(image\/(?:jpeg|png|gif|webp))$/i.test(
    args.mimeType,
  );
  const supportedPdf = args.mimeType.toLowerCase() === "application/pdf";
  if (!supportedImage && !supportedPdf) return null;

  const { apiKey, baseURL } = config();
  const dataUrl = `data:${args.mimeType};base64,${Buffer.from(args.bytes).toString("base64")}`;
  const fileInput = supportedImage
    ? { type: "input_image", image_url: dataUrl, detail: "high" }
    : {
        type: "input_file",
        filename: args.fileName || "deposit-attachment.pdf",
        file_data: dataUrl,
      };
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: process.env.OPENAI_QBO_ATTACHMENT_MODEL ?? DEFAULT_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `This is supporting evidence attached to a QuickBooks bank deposit totaling $${args.depositTotal}. Identify each separate incoming payment visibly included in the attachment packet (for example, each check). Do not infer missing payments and do not treat subtotals or the deposit total as separate payments. Return strict JSON only: {"components":[{"amount":"0.00","payerName":null,"checkNumber":null,"reference":null}]}. Preserve payer and check/reference text when legible; use null when unknown.`,
            },
            fileInput,
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "quickbooks_deposit_composition",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["components"],
            properties: {
              components: {
                type: "array",
                minItems: 2,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["amount", "payerName", "checkNumber", "reference"],
                  properties: {
                    amount: { type: "string" },
                    payerName: { type: ["string", "null"] },
                    checkNumber: { type: ["string", "null"] },
                    reference: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    }),
  });
  if (!response.ok) {
    logger.warn(
      { status: response.status },
      "QuickBooks attachment extraction failed",
    );
    throw new Error("OpenAI could not read the QuickBooks attachment.");
  }
  const parsed = parseJson(outputText(await response.json()));
  return validateAttachmentComposition(args.depositTotal, parsed.components);
}
