import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import { db } from "@workspace/db";
import {
  emails,
  flodeskSyncState,
  FLODESK_SYNC_STATE_ID,
  newsletterCampaigns,
  newsletterEngagement,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";

const DAILY_WINDOW_MS = 20 * 60 * 60 * 1_000;
const WEEKLY_WINDOW_MS = (7 * 24 - 4) * 60 * 60 * 1_000;
const FRESH_CAMPAIGN_MS = 14 * 24 * 60 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 100;

type JsonObject = Record<string, unknown>;

export interface McpToolCaller {
  listTools(): Promise<{ tools: Tool[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface FlodeskMcpCampaign {
  providerCampaignId: string;
  subject: string;
  sentAt: Date;
  previewUrl: string | null;
  openRate: number | null;
  clickRate: number | null;
}

export interface FlodeskMcpRecipient {
  email: string;
  firstName: string | null;
  lastName: string | null;
  deliveredAt: Date | null;
  opened: boolean;
  lastOpenedAt: Date | null;
  totalOpens: number;
  clicked: boolean;
  lastClickedAt: Date | null;
  totalClicks: number;
  clickedLinks: string[];
}

export interface FlodeskEngagementSyncSummary {
  campaignsChecked: number;
  campaignsRefreshed: number;
  engagementRecordsUpserted: number;
}

export interface FlodeskCampaignSyncPlan {
  campaignsChecked: number;
  dueCampaigns: FlodeskMcpCampaign[];
}

export interface FlodeskRecipientPageImportSummary {
  campaignId: string;
  providerCampaignId: string;
  engagementRecordsUpserted: number;
  linkedRecords: number;
  unmatchedRecords: number;
  campaignCompleted: boolean;
}

export function isFlodeskMcpConfigured(): boolean {
  return !!process.env["FLODESK_MCP_URL"]?.trim();
}

function requiredMcpUrl(): URL {
  const raw = process.env["FLODESK_MCP_URL"]?.trim();
  if (!raw) throw new Error("FLODESK_MCP_URL is not configured");
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error("FLODESK_MCP_URL must use HTTPS");
  }
  return parsed;
}

async function connectFlodeskMcp(): Promise<McpToolCaller> {
  const token = process.env["FLODESK_MCP_AUTH_TOKEN"]?.trim();
  const transport = new StreamableHTTPClientTransport(requiredMcpUrl(), {
    ...(token ? { authProvider: { token: async () => token } } : {}),
    requestInit: {
      headers: {
        "User-Agent": "wildflower-crm (engineering@wildflowerschools.org)",
      },
    },
  });
  const client = new Client(
    { name: "wildflower-crm", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return {
    listTools: () => client.listTools(),
    callTool: (params) => client.callTool(params),
    close: async () => {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    },
  };
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function valueAt(row: JsonObject, names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return undefined;
}

function stringAt(row: JsonObject, names: string[]): string | null {
  const value = valueAt(row, names);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberAt(row: JsonObject, names: string[]): number | null {
  const value = valueAt(row, names);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[% ,]/g, ""));
    if (Number.isFinite(parsed))
      return value.includes("%") ? parsed / 100 : parsed;
  }
  return null;
}

function booleanAt(row: JsonObject, names: string[]): boolean | null {
  const value = valueAt(row, names);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      ["true", "yes", "1", "opened", "clicked", "delivered"].includes(
        normalized,
      )
    )
      return true;
    if (
      [
        "false",
        "no",
        "0",
        "not_opened",
        "not_clicked",
        "not_delivered",
      ].includes(normalized)
    )
      return false;
  }
  return null;
}

function dateAt(row: JsonObject, names: string[]): Date | null {
  const value = valueAt(row, names);
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    !(value instanceof Date)
  )
    return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rateAt(row: JsonObject, names: string[]): number | null {
  const parsed = numberAt(row, names);
  if (parsed === null || parsed < 0) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function arraysIn(value: unknown, preferredKeys: string[]): unknown[][] {
  const root = object(value);
  if (!root) return Array.isArray(value) ? [value] : [];
  const preferred: unknown[][] = [];
  for (const key of preferredKeys) {
    if (Array.isArray(root[key])) preferred.push(root[key] as unknown[]);
  }
  if (preferred.length) return preferred;
  for (const child of Object.values(root)) {
    if (Array.isArray(child)) preferred.push(child);
    else if (object(child)) preferred.push(...arraysIn(child, preferredKeys));
  }
  return preferred;
}

function jsonFromToolResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const part of result.content) {
    if (part.type !== "text") continue;
    try {
      return JSON.parse(part.text);
    } catch {
      // Some MCP servers include a short prose preface around a JSON payload.
      const start = Math.min(
        ...[part.text.indexOf("{"), part.text.indexOf("[")].filter(
          (n) => n >= 0,
        ),
      );
      if (Number.isFinite(start)) {
        try {
          return JSON.parse(part.text.slice(start));
        } catch {
          continue;
        }
      }
    }
  }
  throw new Error("Flodesk MCP returned no structured JSON data");
}

export function parseFlodeskCampaigns(value: unknown): FlodeskMcpCampaign[] {
  const found = new Map<string, FlodeskMcpCampaign>();
  for (const rows of arraysIn(value, [
    "emails",
    "campaigns",
    "results",
    "items",
    "data",
  ])) {
    for (const raw of rows) {
      const row = object(raw);
      if (!row) continue;
      const providerCampaignId = stringAt(row, [
        "email_id",
        "emailId",
        "email_uuid",
        "emailUuid",
        "campaign_id",
        "campaignId",
        "id",
      ]);
      const sentAt = dateAt(row, [
        "sent_at",
        "sentAt",
        "date_sent",
        "dateSent",
        "sent_date",
        "send_date",
        "sendAt",
      ]);
      const subject = stringAt(row, [
        "subject",
        "email_name",
        "emailName",
        "title",
        "name",
      ]);
      if (!providerCampaignId || !sentAt || !subject) continue;
      found.set(providerCampaignId, {
        providerCampaignId,
        subject,
        sentAt,
        previewUrl: stringAt(row, [
          "preview_url",
          "previewUrl",
          "email_preview_link",
          "browser_url",
        ]),
        openRate: rateAt(row, ["open_rate", "openRate", "unique_open_rate"]),
        clickRate: rateAt(row, [
          "click_rate",
          "clickRate",
          "unique_click_rate",
        ]),
      });
    }
  }
  return [...found.values()].sort(
    (a, b) => b.sentAt.getTime() - a.sentAt.getTime(),
  );
}

function clickedLinks(row: JsonObject): string[] {
  const value = valueAt(row, [
    "clicked_links",
    "clickedLinks",
    "links_clicked",
    "links",
    "clicks",
  ]);
  if (!Array.isArray(value)) return [];
  const urls = value.flatMap((item) => {
    if (typeof item === "string") return [item.trim()];
    const link = object(item);
    return link
      ? [stringAt(link, ["url", "href", "link", "destination_url"]) ?? ""]
      : [];
  });
  return [...new Set(urls.filter(Boolean))];
}

export function parseFlodeskRecipients(value: unknown): FlodeskMcpRecipient[] {
  const found = new Map<string, FlodeskMcpRecipient>();
  for (const rows of arraysIn(value, [
    "recipients",
    "subscribers",
    "results",
    "items",
    "data",
  ])) {
    for (const raw of rows) {
      const row = object(raw);
      if (!row) continue;
      const address = stringAt(row, [
        "email",
        "email_address",
        "emailAddress",
      ])?.toLowerCase();
      if (!address || !address.includes("@")) continue;
      const links = clickedLinks(row);
      const openEvents = Array.isArray(row["opens"]) ? row["opens"] : [];
      const clickEvents = Array.isArray(row["clicks"]) ? row["clicks"] : [];
      const eventDate = (events: unknown[]): Date | null =>
        events.reduce<Date | null>((latest, item) => {
          const event = object(item);
          const candidate = event
            ? dateAt(event, [
                "occurred_at",
                "occurredAt",
                "clicked_at",
                "opened_at",
                "timestamp",
                "date",
              ])
            : null;
          return !candidate || (latest && latest > candidate)
            ? latest
            : candidate;
        }, null);
      const totalOpens = Math.max(
        0,
        Math.round(
          numberAt(row, ["total_opens", "totalOpens", "open_count"]) ??
            openEvents.length,
        ),
      );
      const totalClicks = Math.max(
        0,
        Math.round(
          numberAt(row, ["total_clicks", "totalClicks", "click_count"]) ??
            Math.max(clickEvents.length, links.length),
        ),
      );
      const opened =
        booleanAt(row, ["opened", "has_opened", "did_open"]) ?? totalOpens > 0;
      const clicked =
        booleanAt(row, ["clicked", "has_clicked", "did_click"]) ??
        (totalClicks > 0 || links.length > 0);
      found.set(address, {
        email: address,
        firstName: stringAt(row, ["first_name", "firstName"]),
        lastName: stringAt(row, ["last_name", "lastName"]),
        deliveredAt: dateAt(row, ["delivered_at", "deliveredAt", "delivered"]),
        opened,
        lastOpenedAt:
          dateAt(row, ["last_opened_at", "lastOpenedAt", "last_opened"]) ??
          eventDate(openEvents),
        totalOpens: opened ? Math.max(1, totalOpens) : 0,
        clicked,
        lastClickedAt:
          dateAt(row, ["last_clicked_at", "lastClickedAt", "last_clicked"]) ??
          eventDate(clickEvents),
        totalClicks: clicked ? Math.max(1, totalClicks) : 0,
        clickedLinks: links,
      });
    }
  }
  return [...found.values()];
}

function schemaProperties(tool: Tool): Record<string, JsonObject> {
  const schema = object(tool.inputSchema);
  const properties = schema ? object(schema["properties"]) : null;
  return (properties ?? {}) as Record<string, JsonObject>;
}

function setRecognizedArg(
  args: Record<string, unknown>,
  properties: Record<string, JsonObject>,
  names: string[],
  value: unknown,
): string | null {
  const name = names.find((candidate) => properties[candidate]);
  if (!name) return null;
  args[name] = value;
  return name;
}

function enumChoice(
  schema: JsonObject | undefined,
  preferred: string[],
): string | null {
  const values = schema && Array.isArray(schema["enum"]) ? schema["enum"] : [];
  const strings = values.filter(
    (value): value is string => typeof value === "string",
  );
  for (const wanted of preferred) {
    const found = strings.find((value) => value.toLowerCase() === wanted);
    if (found) return found;
  }
  return strings[0] ?? null;
}

function rankEmailsArgs(tool: Tool): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const args: Record<string, unknown> = {};
  const metricName = ["metric", "rank_by", "sort_by"].find(
    (name) => properties[name],
  );
  if (metricName) {
    const choice = enumChoice(properties[metricName], [
      "sent_at",
      "date_sent",
      "total_sent",
      "clicks",
    ]);
    args[metricName] = choice ?? "clicks";
  }
  setRecognizedArg(
    args,
    properties,
    ["limit", "per_page", "page_size"],
    DEFAULT_PAGE_SIZE,
  );
  const periodName = ["period", "timeframe", "time_period", "date_range"].find(
    (name) => properties[name],
  );
  if (periodName) {
    const choice = enumChoice(properties[periodName], [
      "all_time",
      "all",
      "lifetime",
    ]);
    if (choice) args[periodName] = choice;
  }
  setRecognizedArg(
    args,
    properties,
    ["start_date", "startDate", "from"],
    "2010-01-01",
  );
  setRecognizedArg(
    args,
    properties,
    ["end_date", "endDate", "to"],
    new Date().toISOString().slice(0, 10),
  );
  setRecognizedArg(args, properties, ["page"], 1);
  setRecognizedArg(args, properties, ["offset"], 0);
  return args;
}

function recipientArgs(
  tool: Tool,
  campaignId: string,
  cursor?: string,
): Record<string, unknown> {
  const properties = schemaProperties(tool);
  const args: Record<string, unknown> = {};
  const idName = setRecognizedArg(
    args,
    properties,
    [
      "email_id",
      "emailId",
      "email_uuid",
      "emailUuid",
      "campaign_id",
      "campaignId",
      "id",
    ],
    campaignId,
  );
  if (!idName)
    throw new Error(
      "Flodesk MCP list_email_recipients schema has no email id input",
    );
  setRecognizedArg(
    args,
    properties,
    ["limit", "per_page", "page_size"],
    DEFAULT_PAGE_SIZE,
  );
  if (cursor)
    setRecognizedArg(
      args,
      properties,
      ["cursor", "next_cursor", "page_token", "after"],
      cursor,
    );
  const viewName = ["view", "status", "filter"].find(
    (name) => properties[name],
  );
  if (viewName) {
    const choice = enumChoice(properties[viewName], [
      "all",
      "sent",
      "recipients",
    ]);
    if (choice) args[viewName] = choice;
  }
  return args;
}

function nextCursor(value: unknown): string | null {
  const row = object(value);
  if (!row) return null;
  const direct = stringAt(row, [
    "next_cursor",
    "nextCursor",
    "next_page_token",
    "nextPageToken",
  ]);
  if (direct) return direct;
  for (const child of Object.values(row)) {
    const nested = object(child) ? nextCursor(child) : null;
    if (nested) return nested;
  }
  return null;
}

export function isFlodeskCampaignDue(
  campaign: Pick<FlodeskMcpCampaign, "sentAt"> & {
    lastEngagementSyncedAt: Date | null;
  },
  now = new Date(),
): boolean {
  if (campaign.sentAt > now) return false;
  if (!campaign.lastEngagementSyncedAt) return true;
  const age = now.getTime() - campaign.sentAt.getTime();
  const elapsed = now.getTime() - campaign.lastEngagementSyncedAt.getTime();
  return (
    elapsed >= (age <= FRESH_CAMPAIGN_MS ? DAILY_WINDOW_MS : WEEKLY_WINDOW_MS)
  );
}

async function findStoredCampaign(campaign: FlodeskMcpCampaign): Promise<{
  id: string;
  lastEngagementSyncedAt: Date | null;
} | null> {
  const byProvider = await db
    .select({
      id: newsletterCampaigns.id,
      lastEngagementSyncedAt: newsletterCampaigns.lastEngagementSyncedAt,
    })
    .from(newsletterCampaigns)
    .where(
      eq(newsletterCampaigns.providerCampaignId, campaign.providerCampaignId),
    )
    .limit(1)
    .then((rows) => rows[0]);
  const historical = byProvider
    ? null
    : await db
        .select({
          id: newsletterCampaigns.id,
          lastEngagementSyncedAt: newsletterCampaigns.lastEngagementSyncedAt,
        })
        .from(newsletterCampaigns)
        .where(
          and(
            sql`date(${newsletterCampaigns.sentAt} at time zone 'UTC') = ${campaign.sentAt.toISOString().slice(0, 10)}::date`,
            sql`lower(trim(${newsletterCampaigns.subject})) = lower(trim(${campaign.subject}))`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
  return byProvider ?? historical ?? null;
}

async function findOrCreateCampaign(campaign: FlodeskMcpCampaign): Promise<{
  id: string;
  lastEngagementSyncedAt: Date | null;
}> {
  const matched = await findStoredCampaign(campaign);
  const id = matched?.id ?? `flodesk:mcp:${campaign.providerCampaignId}`;

  await db
    .insert(newsletterCampaigns)
    .values({
      id,
      providerCampaignId: campaign.providerCampaignId,
      subject: campaign.subject,
      sentAt: campaign.sentAt,
      sentTimeText: campaign.sentAt.toISOString(),
      previewUrl: campaign.previewUrl,
      openRate: campaign.openRate === null ? null : String(campaign.openRate),
      clickRate:
        campaign.clickRate === null ? null : String(campaign.clickRate),
      sourceSheet: "Flodesk MCP",
    })
    .onConflictDoUpdate({
      target: newsletterCampaigns.id,
      set: {
        providerCampaignId: campaign.providerCampaignId,
        subject: campaign.subject,
        sentAt: campaign.sentAt,
        previewUrl: campaign.previewUrl,
        openRate: campaign.openRate === null ? null : String(campaign.openRate),
        clickRate:
          campaign.clickRate === null ? null : String(campaign.clickRate),
        updatedAt: new Date(),
      },
    });
  return {
    id,
    lastEngagementSyncedAt: matched?.lastEngagementSyncedAt ?? null,
  };
}

async function upsertRecipients(
  campaignId: string,
  recipients: FlodeskMcpRecipient[],
): Promise<number> {
  if (!recipients.length) return 0;
  const addressRows = await db
    .select({ id: emails.id, email: emails.email })
    .from(emails)
    .where(
      sql`lower(${emails.email}) IN (${sql.join(
        recipients.map((row) => sql`${row.email}`),
        sql`, `,
      )})`,
    );
  const emailIdByAddress = new Map(
    addressRows.map((row) => [row.email.trim().toLowerCase(), row.id]),
  );

  for (let start = 0; start < recipients.length; start += 300) {
    const batch = recipients.slice(start, start + 300);
    await db
      .insert(newsletterEngagement)
      .values(
        batch.map((row) => ({
          campaignId,
          normalizedEmail: row.email,
          email: row.email,
          emailId: emailIdByAddress.get(row.email) ?? null,
          firstName: row.firstName,
          lastName: row.lastName,
          deliveredAt: row.deliveredAt,
          opened: row.opened,
          lastOpenedAt: row.lastOpenedAt,
          totalOpens: row.totalOpens,
          clicked: row.clicked,
          lastClickedAt: row.lastClickedAt,
          totalClicks: row.totalClicks,
          clickedLinks: row.clickedLinks,
        })),
      )
      .onConflictDoUpdate({
        target: [
          newsletterEngagement.campaignId,
          newsletterEngagement.normalizedEmail,
        ],
        set: {
          email: sql`excluded.email`,
          emailId: sql`excluded.email_id`,
          firstName: sql`coalesce(excluded.first_name, ${newsletterEngagement.firstName})`,
          lastName: sql`coalesce(excluded.last_name, ${newsletterEngagement.lastName})`,
          deliveredAt: sql`coalesce(excluded.delivered_at, ${newsletterEngagement.deliveredAt})`,
          opened: sql`${newsletterEngagement.opened} or excluded.opened`,
          lastOpenedAt: sql`greatest(${newsletterEngagement.lastOpenedAt}, excluded.last_opened_at)`,
          totalOpens: sql`greatest(${newsletterEngagement.totalOpens}, excluded.total_opens)`,
          clicked: sql`${newsletterEngagement.clicked} or excluded.clicked`,
          lastClickedAt: sql`greatest(${newsletterEngagement.lastClickedAt}, excluded.last_clicked_at)`,
          totalClicks: sql`greatest(${newsletterEngagement.totalClicks}, excluded.total_clicks)`,
          clickedLinks: sql`ARRAY(
            SELECT DISTINCT link
            FROM unnest(${newsletterEngagement.clickedLinks} || excluded.clicked_links) AS link
            WHERE link <> ''
            ORDER BY link
          )`,
          updatedAt: new Date(),
        },
      });
  }
  return recipients.length;
}

/**
 * Read-only planning boundary used by the ChatGPT bridge. New campaigns are
 * reported as due but are not persisted until recipient evidence arrives.
 * That keeps a failed or abandoned scheduled task from creating empty
 * campaigns or advancing any watermark.
 */
export async function planFlodeskCampaignEngagement(
  campaigns: FlodeskMcpCampaign[],
  now = new Date(),
): Promise<FlodeskCampaignSyncPlan> {
  const dueCampaigns: FlodeskMcpCampaign[] = [];
  for (const campaign of campaigns) {
    const stored = await findStoredCampaign(campaign);
    if (
      isFlodeskCampaignDue(
        {
          sentAt: campaign.sentAt,
          lastEngagementSyncedAt: stored?.lastEngagementSyncedAt ?? null,
        },
        now,
      )
    ) {
      dueCampaigns.push(campaign);
    }
  }
  return { campaignsChecked: campaigns.length, dueCampaigns };
}

/**
 * Accept one fully retrieved Flodesk recipient page. Page imports are
 * monotonic and idempotent; only the page marked final advances the campaign
 * watermark. If a scheduled task stops mid-pagination, the campaign remains
 * due and the next run safely replays the pages.
 */
export async function importFlodeskRecipientPage(opts: {
  campaign: FlodeskMcpCampaign;
  recipients: FlodeskMcpRecipient[];
  finalPage: boolean;
  observedAt?: Date;
}): Promise<FlodeskRecipientPageImportSummary> {
  const observedAt = opts.observedAt ?? new Date();
  const stored = await findOrCreateCampaign(opts.campaign);
  const engagementRecordsUpserted = await upsertRecipients(
    stored.id,
    opts.recipients,
  );
  const linkedRecords = opts.recipients.length
    ? await db
        .select({
          count: sql<number>`count(*) filter (where ${newsletterEngagement.emailId} is not null)::int`,
        })
        .from(newsletterEngagement)
        .where(
          and(
            eq(newsletterEngagement.campaignId, stored.id),
            sql`${newsletterEngagement.normalizedEmail} IN (${sql.join(
              opts.recipients.map((row) => sql`${row.email}`),
              sql`, `,
            )})`,
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0))
    : 0;

  if (opts.finalPage) {
    await db
      .update(newsletterCampaigns)
      .set({ lastEngagementSyncedAt: observedAt, updatedAt: observedAt })
      .where(eq(newsletterCampaigns.id, stored.id));
  }

  return {
    campaignId: stored.id,
    providerCampaignId: opts.campaign.providerCampaignId,
    engagementRecordsUpserted,
    linkedRecords,
    unmatchedRecords: engagementRecordsUpserted - linkedRecords,
    campaignCompleted: opts.finalPage,
  };
}

/** Record aggregate completion evidence after every due campaign finished. */
export async function completeFlodeskEngagementBridgeRun(opts: {
  campaignsChecked: number;
  campaignsRefreshed: number;
  engagementRecordsUpserted: number;
  finishedAt?: Date;
}): Promise<void> {
  const finishedAt = opts.finishedAt ?? new Date();
  await db
    .insert(flodeskSyncState)
    .values({
      id: FLODESK_SYNC_STATE_ID,
      lastRunStartedAt: finishedAt,
      lastRunFinishedAt: finishedAt,
      lastStatus: "ok",
      campaignsChecked: opts.campaignsChecked,
      campaignsRefreshed: opts.campaignsRefreshed,
      engagementRecordsUpserted: opts.engagementRecordsUpserted,
      lastError: null,
      updatedAt: finishedAt,
    })
    .onConflictDoUpdate({
      target: flodeskSyncState.id,
      set: {
        lastRunFinishedAt: finishedAt,
        lastStatus: "ok",
        campaignsChecked: opts.campaignsChecked,
        campaignsRefreshed: opts.campaignsRefreshed,
        engagementRecordsUpserted: opts.engagementRecordsUpserted,
        lastError: null,
        updatedAt: finishedAt,
      },
    });
}

export async function syncFlodeskCampaignEngagement(opts?: {
  now?: Date;
  caller?: McpToolCaller;
}): Promise<FlodeskEngagementSyncSummary> {
  const now = opts?.now ?? new Date();
  const caller = opts?.caller ?? (await connectFlodeskMcp());
  try {
    const { tools } = await caller.listTools();
    const rankEmails = tools.find((tool) => tool.name === "rank_emails");
    const listRecipients = tools.find(
      (tool) => tool.name === "list_email_recipients",
    );
    if (!rankEmails || !listRecipients) {
      throw new Error(
        "Flodesk MCP must expose rank_emails and list_email_recipients",
      );
    }

    const campaignsResult = await caller.callTool({
      name: rankEmails.name,
      arguments: rankEmailsArgs(rankEmails),
    });
    if (campaignsResult.isError)
      throw new Error("Flodesk MCP rank_emails failed");
    const campaigns = parseFlodeskCampaigns(
      jsonFromToolResult(campaignsResult),
    );
    if (!campaigns.length) {
      throw new Error("Flodesk MCP returned no parseable sent email campaigns");
    }

    const summary: FlodeskEngagementSyncSummary = {
      campaignsChecked: campaigns.length,
      campaignsRefreshed: 0,
      engagementRecordsUpserted: 0,
    };

    for (const campaign of campaigns) {
      const stored = await findOrCreateCampaign(campaign);
      if (
        !isFlodeskCampaignDue(
          {
            sentAt: campaign.sentAt,
            lastEngagementSyncedAt: stored.lastEngagementSyncedAt,
          },
          now,
        )
      )
        continue;

      const recipients = new Map<string, FlodeskMcpRecipient>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        pages += 1;
        if (pages > 100)
          throw new Error(
            `Flodesk MCP recipient pagination exceeded 100 pages for ${campaign.providerCampaignId}`,
          );
        const result = await caller.callTool({
          name: listRecipients.name,
          arguments: recipientArgs(
            listRecipients,
            campaign.providerCampaignId,
            cursor,
          ),
        });
        if (result.isError) {
          throw new Error(
            `Flodesk MCP list_email_recipients failed for ${campaign.providerCampaignId}`,
          );
        }
        const payload = jsonFromToolResult(result);
        for (const recipient of parseFlodeskRecipients(payload))
          recipients.set(recipient.email, recipient);
        const next = nextCursor(payload);
        if (!next || next === cursor) break;
        cursor = next;
      } while (cursor);

      summary.engagementRecordsUpserted += await upsertRecipients(stored.id, [
        ...recipients.values(),
      ]);
      await db
        .update(newsletterCampaigns)
        .set({ lastEngagementSyncedAt: now, updatedAt: now })
        .where(eq(newsletterCampaigns.id, stored.id));
      summary.campaignsRefreshed += 1;
    }

    logger.info({ summary }, "Flodesk MCP campaign engagement sync finished");
    return summary;
  } finally {
    if (!opts?.caller)
      await caller
        .close()
        .catch((err) => logger.warn({ err }, "Flodesk MCP close failed"));
  }
}
