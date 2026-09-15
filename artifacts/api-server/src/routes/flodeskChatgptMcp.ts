import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  completeFlodeskEngagementBridgeRun,
  importFlodeskRecipientPage,
  planFlodeskCampaignEngagement,
  type FlodeskMcpCampaign,
  type FlodeskMcpRecipient,
} from "../lib/flodeskMcp";
import { logger } from "../lib/logger";

const MCP_PATH = "/integrations/flodesk-chatgpt/mcp";
const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

const campaignSchema = z.object({
  providerCampaignId: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(1_000),
  sentAt: z.string().datetime({ offset: true }),
  previewUrl: z.string().url().max(5_000).nullable().optional(),
  openRate: z.number().min(0).max(100).nullable().optional(),
  clickRate: z.number().min(0).max(100).nullable().optional(),
});

const recipientSchema = z.object({
  email: z.string().trim().email().max(500),
  firstName: z.string().trim().max(500).nullable().optional(),
  lastName: z.string().trim().max(500).nullable().optional(),
  deliveredAt: z.string().datetime({ offset: true }).nullable().optional(),
  opened: z.boolean(),
  lastOpenedAt: z.string().datetime({ offset: true }).nullable().optional(),
  totalOpens: z.number().int().min(0).max(1_000_000),
  clicked: z.boolean(),
  lastClickedAt: z.string().datetime({ offset: true }).nullable().optional(),
  totalClicks: z.number().int().min(0).max(1_000_000),
  clickedLinks: z.array(z.string().url().max(5_000)).max(500).default([]),
});

const planArgsSchema = z.object({
  campaigns: z.array(campaignSchema).min(1).max(500),
});

const importPageArgsSchema = z.object({
  campaign: campaignSchema,
  recipients: z.array(recipientSchema).max(500),
  finalPage: z.boolean(),
});

const completeArgsSchema = z.object({
  campaignsChecked: z.number().int().min(0).max(10_000),
  campaignsRefreshed: z.number().int().min(0).max(10_000),
  engagementRecordsUpserted: z.number().int().min(0).max(10_000_000),
});

type RpcId = string | number | null;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: RpcId;
  method: string;
  params?: unknown;
}

const campaignJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providerCampaignId", "subject", "sentAt"],
  properties: {
    providerCampaignId: {
      type: "string",
      description: "Flodesk's stable email id.",
    },
    subject: { type: "string" },
    sentAt: { type: "string", format: "date-time" },
    previewUrl: { type: ["string", "null"], format: "uri" },
    openRate: {
      type: ["number", "null"],
      description: "A fraction (0-1) or percentage (0-100).",
    },
    clickRate: {
      type: ["number", "null"],
      description: "A fraction (0-1) or percentage (0-100).",
    },
  },
} as const;

const recipientJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "email",
    "opened",
    "totalOpens",
    "clicked",
    "totalClicks",
    "clickedLinks",
  ],
  properties: {
    email: { type: "string", format: "email" },
    firstName: { type: ["string", "null"] },
    lastName: { type: ["string", "null"] },
    deliveredAt: { type: ["string", "null"], format: "date-time" },
    opened: { type: "boolean" },
    lastOpenedAt: { type: ["string", "null"], format: "date-time" },
    totalOpens: { type: "integer", minimum: 0 },
    clicked: { type: "boolean" },
    lastClickedAt: { type: ["string", "null"], format: "date-time" },
    totalClicks: { type: "integer", minimum: 0 },
    clickedLinks: {
      type: "array",
      items: { type: "string", format: "uri" },
    },
  },
} as const;

export const FLODESK_CHATGPT_TOOLS = [
  {
    name: "plan_flodesk_engagement_sync",
    title: "Plan Flodesk engagement sync",
    description:
      "Compare all sent Flodesk campaigns with WFCRM watermarks. Pass the complete campaign list from Flodesk rank_emails. Returns only campaigns whose recipient evidence is due: daily for 14 days after send, then weekly. This is read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["campaigns"],
      properties: {
        campaigns: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: campaignJsonSchema,
        },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "import_flodesk_recipient_page",
    title: "Import one Flodesk recipient page",
    description:
      "Monotonically upsert one complete page returned by Flodesk list_email_recipients for a due campaign. Call once per page in cursor order. Set finalPage=true only after Flodesk returns no next cursor; only that call advances the campaign watermark. Never omit a page.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["campaign", "recipients", "finalPage"],
      properties: {
        campaign: campaignJsonSchema,
        recipients: {
          type: "array",
          maxItems: 500,
          items: recipientJsonSchema,
        },
        finalPage: { type: "boolean" },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "complete_flodesk_engagement_sync",
    title: "Complete Flodesk engagement sync",
    description:
      "Record aggregate completion evidence after every due campaign and every recipient page has imported successfully. Do not call this if any Flodesk or WFCRM call failed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "campaignsChecked",
        "campaignsRefreshed",
        "engagementRecordsUpserted",
      ],
      properties: {
        campaignsChecked: { type: "integer", minimum: 0 },
        campaignsRefreshed: { type: "integer", minimum: 0 },
        engagementRecordsUpserted: { type: "integer", minimum: 0 },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

function normalizedRate(value: number | null | undefined): number | null {
  if (value == null) return null;
  return value > 1 ? value / 100 : value;
}

function campaignFromInput(
  input: z.infer<typeof campaignSchema>,
): FlodeskMcpCampaign {
  return {
    providerCampaignId: input.providerCampaignId,
    subject: input.subject,
    sentAt: new Date(input.sentAt),
    previewUrl: input.previewUrl ?? null,
    openRate: normalizedRate(input.openRate),
    clickRate: normalizedRate(input.clickRate),
  };
}

function recipientFromInput(
  input: z.infer<typeof recipientSchema>,
): FlodeskMcpRecipient {
  return {
    email: input.email.toLowerCase(),
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    deliveredAt: input.deliveredAt ? new Date(input.deliveredAt) : null,
    opened: input.opened,
    lastOpenedAt: input.lastOpenedAt ? new Date(input.lastOpenedAt) : null,
    totalOpens: input.opened ? Math.max(1, input.totalOpens) : 0,
    clicked: input.clicked,
    lastClickedAt: input.lastClickedAt ? new Date(input.lastClickedAt) : null,
    totalClicks: input.clicked ? Math.max(1, input.totalClicks) : 0,
    clickedLinks: [...new Set(input.clickedLinks)],
  };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

async function callTool(params: unknown): Promise<unknown> {
  const parsed = z
    .object({ name: z.string(), arguments: z.unknown().optional() })
    .safeParse(params);
  if (!parsed.success) throw new Error("Invalid tools/call parameters");

  if (parsed.data.name === "plan_flodesk_engagement_sync") {
    const args = planArgsSchema.parse(parsed.data.arguments ?? {});
    const plan = await planFlodeskCampaignEngagement(
      args.campaigns.map(campaignFromInput),
    );
    return toolResult({
      campaignsChecked: plan.campaignsChecked,
      dueCampaigns: plan.dueCampaigns.map((campaign) => ({
        ...campaign,
        sentAt: campaign.sentAt.toISOString(),
      })),
    });
  }

  if (parsed.data.name === "import_flodesk_recipient_page") {
    const args = importPageArgsSchema.parse(parsed.data.arguments ?? {});
    return toolResult(
      await importFlodeskRecipientPage({
        campaign: campaignFromInput(args.campaign),
        recipients: args.recipients.map(recipientFromInput),
        finalPage: args.finalPage,
      }),
    );
  }

  if (parsed.data.name === "complete_flodesk_engagement_sync") {
    const args = completeArgsSchema.parse(parsed.data.arguments ?? {});
    await completeFlodeskEngagementBridgeRun(args);
    return toolResult({ status: "ok" });
  }

  throw new Error(`Unknown tool: ${parsed.data.name}`);
}

export async function handleFlodeskChatgptMcpRequest(
  value: unknown,
): Promise<unknown | null> {
  const parsed = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string(), z.number(), z.null()]).optional(),
      method: z.string(),
      params: z.unknown().optional(),
    })
    .safeParse(value);
  if (!parsed.success) return rpcError(null, -32600, "Invalid Request");
  const request = parsed.data as RpcRequest;
  const id = request.id ?? null;

  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "wildflower-fundraising-crm", version: "1.0.0" },
      instructions:
        "Use these tools only to plan and import Flodesk newsletter engagement into WFCRM. Import every recipient page before completing a campaign.",
    });
  }
  if (request.method === "ping") return rpcResult(id, {});
  if (request.method === "tools/list") {
    return rpcResult(id, { tools: FLODESK_CHATGPT_TOOLS });
  }
  if (request.method === "tools/call") {
    try {
      return rpcResult(id, await callTool(request.params));
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? "Tool arguments failed validation"
          : error instanceof Error
            ? error.message
            : "Tool call failed";
      logger.warn(
        { err: error, tool: (request.params as { name?: unknown })?.name },
        "Flodesk ChatGPT MCP tool call failed",
      );
      return rpcResult(id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, "Method not found");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hasValidFlodeskChatgptMcpToken(req: Request): boolean {
  const configured = process.env["FLODESK_CHATGPT_MCP_AUTH_TOKEN"]?.trim();
  const header = req.get("authorization")?.trim() ?? "";
  const supplied = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  if (!configured || !supplied) return false;
  return timingSafeEqual(digest(supplied), digest(configured));
}

const router: IRouter = Router();
const limiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.post(MCP_PATH, limiter, async (req, res) => {
  if (!process.env["FLODESK_CHATGPT_MCP_AUTH_TOKEN"]?.trim()) {
    res.status(503).json({ error: "flodesk_chatgpt_mcp_not_configured" });
    return;
  }
  if (!hasValidFlodeskChatgptMcpToken(req)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="wfcrm-flodesk-mcp"');
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const requests = Array.isArray(req.body) ? req.body : [req.body];
  const responses: unknown[] = [];
  // Preserve JSON-RPC batch order: an import batch may contain consecutive
  // recipient pages and the final page must never overtake an earlier page.
  for (const request of requests) {
    const response = await handleFlodeskChatgptMcpRequest(request);
    if (response !== null) responses.push(response);
  }
  if (!responses.length) {
    res.status(202).end();
    return;
  }
  res.setHeader("MCP-Protocol-Version", SUPPORTED_PROTOCOL_VERSION);
  res.json(Array.isArray(req.body) ? responses : responses[0]);
});

router.get(MCP_PATH, (_req, res) => {
  res.setHeader("Allow", "POST, DELETE");
  res.status(405).json({ error: "method_not_allowed" });
});

router.delete(MCP_PATH, (_req, res) => res.status(204).end());

export default router;
