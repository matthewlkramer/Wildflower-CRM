import { logger } from "./logger";

/**
 * Minimal Airtable REST client backed by the Replit Airtable connector proxy.
 *
 * Auth: the connector proxy at `REPLIT_CONNECTORS_HOSTNAME` serves a fresh
 * OAuth2 access token on every call (mirrors the Stripe connector pattern in
 * `stripeClient.ts`). We NEVER cache the token — the proxy resolves the org's
 * authorized Airtable account and rotates tokens automatically. As a
 * development convenience, a static `AIRTABLE_TOKEN` secret (a personal-access
 * token) takes precedence when present, so this can run without the connector
 * bound (e.g. from a script or before the connection is wired).
 *
 * The token is never logged; only HTTP status / record counts are.
 *
 * Pull-only: we read records from a base/table/view. We never write to
 * Airtable — Airtable is the source of truth for schools.
 */

const AIRTABLE_API_BASE =
  process.env["AIRTABLE_API_BASE"] ?? "https://api.airtable.com";

/** Raised when no Airtable credential can be resolved — callers fail loudly. */
export class AirtableNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableNotConfiguredError";
  }
}

/** Raised for a non-retryable HTTP error from Airtable. */
export class AirtableApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`Airtable ${status} ${path}: ${body.slice(0, 500)}`);
    this.name = "AirtableApiError";
  }
}

function getStaticToken(): string | null {
  const t =
    process.env["AIRTABLE_API_TOKEN"]?.trim() ||
    process.env["AIRTABLE_TOKEN"]?.trim();
  return t ? t : null;
}

function getReplitToken(): string | null {
  if (process.env["REPL_IDENTITY"]) return `repl ${process.env["REPL_IDENTITY"]}`;
  if (process.env["WEB_REPL_RENEWAL"])
    return `depl ${process.env["WEB_REPL_RENEWAL"]}`;
  return null;
}

/**
 * Cheap, side-effect-free check used by the scheduler / no-op gates. True when
 * Airtable can be reached at all — either via a static token or the connector
 * proxy env. Does NOT prove an Airtable account is actually linked.
 */
export function isAirtableConfigured(): boolean {
  return (
    Boolean(getStaticToken()) ||
    Boolean(process.env["REPLIT_CONNECTORS_HOSTNAME"] && getReplitToken())
  );
}

/**
 * Resolve a fresh Airtable access token. Prefers the static `AIRTABLE_TOKEN`
 * secret; otherwise reads the current token from the connector proxy. Never
 * cached, never logged.
 */
async function fetchAccessToken(): Promise<string> {
  const staticToken = getStaticToken();
  if (staticToken) return staticToken;

  const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
  const token = getReplitToken();
  if (!hostname || !token) {
    throw new AirtableNotConfiguredError(
      "Airtable connector unavailable: set AIRTABLE_TOKEN or connect Airtable " +
        "in the integrations panel (missing REPLIT_CONNECTORS_HOSTNAME / repl identity token).",
    );
  }

  // Replit Airtable connector integration: token served fresh by the proxy.
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=airtable`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: token } },
  );
  if (!res.ok) {
    throw new AirtableNotConfiguredError(
      `Airtable connector proxy returned HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as {
    items?: { settings?: Record<string, unknown> }[];
  };
  const settings = data.items?.[0]?.settings ?? {};
  const accessToken =
    (settings["access_token"] as string | undefined) ||
    (settings["api_key"] as string | undefined) ||
    (settings["token"] as string | undefined);
  if (!accessToken) {
    throw new AirtableNotConfiguredError(
      "Airtable is not connected (no access_token in connector settings) — connect Airtable in the integrations panel.",
    );
  }
  return accessToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw Airtable record: an id plus an arbitrary `fields` map. */
export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface ListRecordsOptions {
  baseId: string;
  tableId: string;
  viewId?: string;
  pageSize?: number;
  /** Max pages to walk before bailing (guards against runaway pagination). */
  maxPages?: number;
  timeoutMs?: number;
  retries?: number;
}

/**
 * List every record in a base/table (optionally constrained to a view),
 * walking Airtable's `offset` pagination. Transient failures (429 / 5xx /
 * network) are retried with linear backoff. The access token is resolved once
 * per call and reused across pages.
 */
export async function listAllRecords(
  opts: ListRecordsOptions,
): Promise<AirtableRecord[]> {
  const {
    baseId,
    tableId,
    viewId,
    pageSize = 100,
    maxPages = 1000,
    timeoutMs = 30_000,
    retries = 3,
  } = opts;

  const accessToken = await fetchAccessToken();
  const out: AirtableRecord[] = [];
  let offset: string | undefined;
  let page = 0;

  do {
    if (page >= maxPages) {
      throw new AirtableApiError(
        599,
        `${baseId}/${tableId}`,
        `pagination exceeded maxPages=${maxPages}`,
      );
    }
    const url = new URL(`${AIRTABLE_API_BASE}/v0/${baseId}/${tableId}`);
    if (viewId) url.searchParams.set("view", viewId);
    url.searchParams.set("pageSize", String(Math.min(Math.max(pageSize, 1), 100)));
    if (offset) url.searchParams.set("offset", offset);

    let json: { records?: AirtableRecord[]; offset?: string } | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        });
        if (res.status === 429 || res.status >= 500) {
          if (attempt < retries) {
            const ra = Number(res.headers.get("retry-after"));
            const waitMs =
              Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (attempt + 1);
            await sleep(waitMs);
            continue;
          }
          throw new AirtableApiError(
            res.status,
            `${baseId}/${tableId}`,
            await res.text(),
          );
        }
        if (!res.ok) {
          throw new AirtableApiError(
            res.status,
            `${baseId}/${tableId}`,
            await res.text(),
          );
        }
        json = (await res.json()) as {
          records?: AirtableRecord[];
          offset?: string;
        };
        break;
      } catch (err) {
        if (err instanceof AirtableApiError) throw err;
        if (attempt < retries) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }

    if (json?.records?.length) out.push(...json.records);
    offset = json?.offset;
    page += 1;
  } while (offset);

  logger.debug(
    { baseId, tableId, viewId, records: out.length, pages: page },
    "Airtable listAllRecords complete",
  );
  return out;
}
