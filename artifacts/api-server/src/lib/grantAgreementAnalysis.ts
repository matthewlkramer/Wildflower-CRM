import type { File } from "@google-cloud/storage";
import { logger } from "./logger";

export const GRANT_REVIEW_PROMPT_VERSION = "grant-review-v1";

const DEFAULT_MODEL = "gpt-5-mini";
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const TERM_KINDS = [
  "donor_restriction",
  "condition",
  "reporting_requirement",
  "payment_requirement",
  "spending_rule",
  "other_requirement",
] as const;
const RESTRICTION_DIMENSIONS = [
  "entity",
  "geography",
  "purpose",
  "time",
  "project",
  "school",
] as const;
const SPENDING_RULE_TYPES = [
  "allowable_cost",
  "prohibited_cost",
  "cap",
  "prior_approval",
] as const;

export interface AnalyzedGrantTerm {
  pledgeAllocationId: null;
  expectedPaymentId: null;
  kind: (typeof TERM_KINDS)[number];
  restrictionDimension: (typeof RESTRICTION_DIMENSIONS)[number] | null;
  spendingRuleType: (typeof SPENDING_RULE_TYPES)[number] | null;
  title: string;
  summary: string;
  exactQuote: string;
  sourcePage: string | null;
  amount: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  barrier: string | null;
  returnOrReleaseRight: string | null;
  consequence: string | null;
  categories: string[] | null;
  capAmount: string | null;
  capPercent: string | null;
}

export interface GrantAgreementAnalysis {
  analysisSummary: string;
  terms: AnalyzedGrantTerm[];
  model: string;
  promptVersion: string;
}

function openAIConfig() {
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

const REVIEW_INSTRUCTIONS = `You are reviewing a nonprofit grant agreement for Wildflower Schools. Produce a conservative proposal for a human reviewer. Use only the uploaded document; never invent terms, dates, amounts, statuses, or page numbers.

Accounting classification rules:
1. A donor restriction is a donor-imposed limit on use by purpose, project, entity/recipient, school, geography, or time. An explicit requirement that the funds be used by or for a named Wildflower entity (including Black Wildflowers Fund) is a restriction. Never label the award unrestricted when any donor restriction exists. Internal plans or Wildflower board designations are not donor restrictions.
2. A contribution is conditional only when the agreement includes BOTH (a) a substantive barrier the recipient must overcome and (b) a donor right of return of transferred assets or release from the promise if the barrier is not overcome. Identify both clauses verbatim. A measurable performance target, matching requirement, specified outcome, limited discretion, or qualifying-cost reimbursement can be a barrier when the document makes entitlement depend on it.
3. A routine report, receipt, invoice, expenditure accounting, audit access, acknowledgement, or payment scheduled after a report is submitted is NOT by itself a condition. Classify it as a reporting_requirement or payment_requirement unless the document also states a substantive barrier and return/release right. Do not infer a return right from a payment schedule.
4. Separate donor restrictions from conditions. A project-use limit can be a restriction even when the grant is unconditional. A condition can coexist with restrictions.
5. Capture operational spending rules: allowable costs, prohibited costs, category or line-item caps, and prior-approval requirements. Do not create expense transactions. Never claim that money has been spent or that a term has been satisfied.
6. Capture other material requirements separately, including reports and payment prerequisites. Do not duplicate the same clause in multiple rows unless it independently creates distinct obligations.

Evidence rules:
- Every proposed row must include exactQuote copied verbatim from the document and sourcePage when visible. Do not put a paraphrase in exactQuote.
- summary and title are plain-language explanations; exactQuote is the source evidence.
- If a clause is ambiguous, classify it as other_requirement and explain the uncertainty in summary rather than upgrading it to a formal condition or donor restriction.
- If the agreement contains no formal condition, do not create a condition row.
- Dates must be YYYY-MM-DD only when explicit and unambiguous. Monetary and percentage fields are decimal strings without symbols; capPercent is 0 through 1.
- Return a short overall analysisSummary and the complete material list.`;

const nullableString = { type: ["string", "null"] } as const;
const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["analysisSummary", "terms"],
  properties: {
    analysisSummary: { type: "string" },
    terms: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          "restrictionDimension",
          "spendingRuleType",
          "title",
          "summary",
          "exactQuote",
          "sourcePage",
          "amount",
          "startDate",
          "endDate",
          "dueDate",
          "barrier",
          "returnOrReleaseRight",
          "consequence",
          "categories",
          "capAmount",
          "capPercent",
        ],
        properties: {
          kind: { type: "string", enum: [...TERM_KINDS] },
          restrictionDimension: {
            type: ["string", "null"],
            enum: [...RESTRICTION_DIMENSIONS, null],
          },
          spendingRuleType: {
            type: ["string", "null"],
            enum: [...SPENDING_RULE_TYPES, null],
          },
          title: { type: "string" },
          summary: { type: "string" },
          exactQuote: { type: "string" },
          sourcePage: nullableString,
          amount: nullableString,
          startDate: nullableString,
          endDate: nullableString,
          dueDate: nullableString,
          barrier: nullableString,
          returnOrReleaseRight: nullableString,
          consequence: nullableString,
          categories: {
            anyOf: [
              { type: "array", items: { type: "string" }, maxItems: 100 },
              { type: "null" },
            ],
          },
          capAmount: nullableString,
          capPercent: nullableString,
        },
      },
    },
  },
} as const;

function cleanNullableString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

function cleanDate(value: unknown): string | null {
  const date = cleanNullableString(value, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

function cleanNonnegativeDecimal(
  value: unknown,
  maximum?: number,
): string | null {
  const decimal = cleanNullableString(value, 40);
  if (!decimal || !/^\d+(\.\d+)?$/.test(decimal)) return null;
  const parsed = Number(decimal);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (maximum != null && parsed > maximum) return null;
  return decimal;
}

export function normalizeAnalyzedGrantTerm(
  raw: unknown,
): AnalyzedGrantTerm | null {
  if (!raw || typeof raw !== "object") return null;
  const term = raw as Record<string, unknown>;
  let kind = TERM_KINDS.includes(term.kind as never)
    ? (term.kind as AnalyzedGrantTerm["kind"])
    : "other_requirement";
  const title = cleanNullableString(term.title, 240);
  const summary = cleanNullableString(term.summary, 10_000);
  const exactQuote = cleanNullableString(term.exactQuote, 20_000);
  if (!title || !summary || !exactQuote) return null;

  const barrier = cleanNullableString(term.barrier, 10_000);
  const returnOrReleaseRight = cleanNullableString(
    term.returnOrReleaseRight,
    10_000,
  );
  // Defense in depth: a model cannot create a formal accounting condition
  // without evidence for both elements. Keep the clause for review, but demote
  // it to a general requirement instead of changing allocation contingency.
  if (kind === "condition" && (!barrier || !returnOrReleaseRight)) {
    kind = "other_requirement";
  }

  const restrictionDimension = RESTRICTION_DIMENSIONS.includes(
    term.restrictionDimension as never,
  )
    ? (term.restrictionDimension as AnalyzedGrantTerm["restrictionDimension"])
    : null;
  const spendingRuleType = SPENDING_RULE_TYPES.includes(
    term.spendingRuleType as never,
  )
    ? (term.spendingRuleType as AnalyzedGrantTerm["spendingRuleType"])
    : null;
  if (kind === "donor_restriction" && !restrictionDimension) {
    kind = "other_requirement";
  }
  if (kind === "spending_rule" && !spendingRuleType) {
    kind = "other_requirement";
  }

  return {
    pledgeAllocationId: null,
    expectedPaymentId: null,
    kind,
    restrictionDimension,
    spendingRuleType,
    title,
    summary,
    exactQuote,
    sourcePage: cleanNullableString(term.sourcePage, 100),
    amount: cleanNonnegativeDecimal(term.amount),
    startDate: cleanDate(term.startDate),
    endDate: cleanDate(term.endDate),
    dueDate: cleanDate(term.dueDate),
    barrier,
    returnOrReleaseRight,
    consequence: cleanNullableString(term.consequence, 10_000),
    categories: Array.isArray(term.categories)
      ? term.categories
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 100)
      : null,
    capAmount: cleanNonnegativeDecimal(term.capAmount),
    capPercent: cleanNonnegativeDecimal(term.capPercent, 1),
  };
}

export async function analyzeGrantAgreementFile(args: {
  file: File;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<GrantAgreementAnalysis> {
  if (args.sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new Error("Grant agreements must be 25 MB or smaller.");
  }
  const [bytes] = await args.file.download();
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("Grant agreements must be 25 MB or smaller.");
  }

  const model =
    process.env.OPENAI_GRANT_REVIEW_MODEL?.trim() ||
    process.env.OPENAI_MEETING_TEXT_MODEL?.trim() ||
    DEFAULT_MODEL;
  const mimeType = args.mimeType || "application/octet-stream";
  const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
  const documentPart = mimeType.startsWith("image/")
    ? { type: "input_image", image_url: dataUrl, detail: "high" }
    : {
        type: "input_file",
        filename: args.fileName || "grant-agreement.pdf",
        file_data: dataUrl,
      };

  const { apiKey, baseURL } = openAIConfig();
  const response = await fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: REVIEW_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Review this grant agreement and return the proposed terms for human review.",
            },
            documentPart,
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "grant_agreement_review",
          strict: true,
          schema: responseSchema,
        },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    logger.warn(
      { status: response.status },
      "OpenAI grant-agreement analysis failed",
    );
    throw new Error("OpenAI could not analyze this grant agreement.");
  }

  const text = outputText(await response.json());
  if (!text) throw new Error("OpenAI returned an empty grant review.");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("OpenAI returned an invalid grant review.");
  }
  const terms = Array.isArray(parsed.terms)
    ? parsed.terms
        .map(normalizeAnalyzedGrantTerm)
        .filter((term): term is AnalyzedGrantTerm => !!term)
    : [];
  const analysisSummary = cleanNullableString(parsed.analysisSummary, 20_000);
  if (!analysisSummary) {
    throw new Error("OpenAI returned an incomplete grant review.");
  }

  return {
    analysisSummary,
    terms,
    model,
    promptVersion: GRANT_REVIEW_PROMPT_VERSION,
  };
}
