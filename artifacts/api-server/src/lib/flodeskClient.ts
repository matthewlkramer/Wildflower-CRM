import { logger } from "./logger";

/**
 * Minimal client for the Flodesk public API (https://api.flodesk.com/v1).
 *
 * Flodesk's public API exposes subscriber + segment management and webhooks
 * only — there is no campaign or open/click analytics. We use it for a
 * subscribe/unsubscribe sync against a single newsletter segment.
 *
 * Auth: Flodesk documents HTTP Basic auth with the API key as the username
 * and an empty password (`Authorization: Basic base64("<key>:")`). The task
 * brief suggested a Bearer token; the scheme is therefore configurable via
 * FLODESK_AUTH_SCHEME ("basic" | "bearer") and defaults to "basic" to match
 * Flodesk's documented contract. Flodesk also requires a descriptive
 * `User-Agent` header or it rejects the request.
 *
 * Every parse path is defensive and transient failures (429 / 5xx / network)
 * are retried with linear backoff so a flaky call never throws mid-loop where
 * the caller has chosen to swallow per-item errors.
 */

const FLODESK_BASE =
  process.env["FLODESK_API_BASE"] ?? "https://api.flodesk.com/v1";

const USER_AGENT =
  process.env["FLODESK_USER_AGENT"] ??
  "wildflower-crm (engineering@wildflowerschools.org)";

/** Raised when the API key secret is absent — the caller should fail loudly. */
export class FlodeskNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlodeskNotConfiguredError";
  }
}

/** Raised for a non-retryable, non-404 HTTP error from Flodesk. */
export class FlodeskApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`Flodesk ${status} ${path}: ${body.slice(0, 500)}`);
    this.name = "FlodeskApiError";
  }
}

/** Resolve the API key from the environment; throw loudly when missing. */
export function getFlodeskApiKey(): string {
  const key = process.env["FLODESK_API_KEY"];
  if (!key || !key.trim()) {
    throw new FlodeskNotConfiguredError(
      "FLODESK_API_KEY is not set — cannot reach Flodesk.",
    );
  }
  return key.trim();
}

/** True when both the API key and the target segment id are configured. */
export function isFlodeskConfigured(): boolean {
  return (
    !!process.env["FLODESK_API_KEY"]?.trim() &&
    !!process.env["FLODESK_SEGMENT_ID"]?.trim()
  );
}

/** Resolve the single newsletter segment id; throw loudly when missing. */
export function getFlodeskSegmentId(): string {
  const id = process.env["FLODESK_SEGMENT_ID"];
  if (!id || !id.trim()) {
    throw new FlodeskNotConfiguredError(
      "FLODESK_SEGMENT_ID is not set — no target segment to sync into.",
    );
  }
  return id.trim();
}

function authHeader(): string {
  const key = getFlodeskApiKey();
  const scheme = (process.env["FLODESK_AUTH_SCHEME"] ?? "basic").toLowerCase();
  if (scheme === "bearer") return `Bearer ${key}`;
  // Basic: api key as username, empty password.
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

export interface FlodeskSegmentRef {
  id?: string;
  name?: string;
}

export interface FlodeskSubscriber {
  id?: string;
  email: string;
  /** "active" | "unsubscribed" | "bounced" | "unconfirmed" | ... */
  status: string | null;
  firstName: string | null;
  lastName: string | null;
  segments: FlodeskSegmentRef[];
}

interface RawSubscriber {
  id?: unknown;
  email?: unknown;
  status?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  segments?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FlodeskFetchOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Treat a 404 as "not found" (return null) instead of throwing. */
  allow404?: boolean;
}

/**
 * Perform one Flodesk request with linear-backoff retry on transient failures.
 * Returns the parsed JSON body (an object), `null` on an allowed 404, or `{}`
 * on an empty 2xx body. Throws FlodeskApiError for non-retryable HTTP errors
 * and rethrows the last network error after exhausting retries.
 */
async function flodeskFetch(
  path: string,
  opts: FlodeskFetchOptions = {},
): Promise<Record<string, unknown> | null> {
  const {
    method = "GET",
    body,
    timeoutMs = 20_000,
    retries = 3,
    allow404 = false,
  } = opts;
  const url = `${FLODESK_BASE}${path}`;
  const auth = authHeader();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: auth,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 404 && allow404) return null;

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          // Honor Retry-After when present, else linear backoff.
          const ra = Number(res.headers.get("retry-after"));
          const waitMs =
            Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        const text = await res.text();
        throw new FlodeskApiError(res.status, path, text);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new FlodeskApiError(res.status, path, text);
      }

      const text = await res.text();
      if (!text.trim()) return {};
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        // A 2xx with an unparseable body — treat as a successful no-content op.
        return {};
      }
    } catch (err) {
      // FlodeskApiError is a definitive HTTP failure — don't retry it here.
      if (err instanceof FlodeskApiError) throw err;
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable, but keeps the type checker happy.
  return {};
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function parseSegments(v: unknown): FlodeskSegmentRef[] {
  if (!Array.isArray(v)) return [];
  const out: FlodeskSegmentRef[] = [];
  for (const s of v) {
    if (s && typeof s === "object") {
      const o = s as { id?: unknown; name?: unknown };
      out.push({
        id: asStr(o.id) ?? undefined,
        name: asStr(o.name) ?? undefined,
      });
    }
  }
  return out;
}

/** Normalize a raw Flodesk subscriber object, or null if it has no email. */
export function parseSubscriber(raw: unknown): FlodeskSubscriber | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawSubscriber;
  const email = asStr(r.email);
  if (!email) return null;
  return {
    id: asStr(r.id) ?? undefined,
    email: email.toLowerCase(),
    status: asStr(r.status),
    firstName: asStr(r.first_name),
    lastName: asStr(r.last_name),
    segments: parseSegments(r.segments),
  };
}

export interface UpsertSubscriberFields {
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Create or update a subscriber by email (Flodesk upserts on POST). Does NOT
 * by itself add the subscriber to a segment — call addSubscriberToSegments.
 */
export async function upsertSubscriber(
  email: string,
  fields: UpsertSubscriberFields = {},
): Promise<FlodeskSubscriber | null> {
  const body: Record<string, unknown> = { email: email.toLowerCase() };
  if (fields.firstName) body["first_name"] = fields.firstName;
  if (fields.lastName) body["last_name"] = fields.lastName;
  const json = await flodeskFetch("/subscribers", { method: "POST", body });
  return parseSubscriber(json);
}

/** Add an existing subscriber to one or more segments. */
export async function addSubscriberToSegments(
  email: string,
  segmentIds: string[],
): Promise<void> {
  if (segmentIds.length === 0) return;
  await flodeskFetch(
    `/subscribers/${encodeURIComponent(email.toLowerCase())}/segments`,
    { method: "POST", body: { segment_ids: segmentIds } },
  );
}

/** Globally unsubscribe a subscriber. Idempotent + safe when not present. */
export async function unsubscribeSubscriber(email: string): Promise<void> {
  await flodeskFetch(
    `/subscribers/${encodeURIComponent(email.toLowerCase())}/unsubscribe`,
    { method: "POST", allow404: true },
  );
}

/** Fetch a single subscriber's current state, or null if not in Flodesk. */
export async function getSubscriber(
  email: string,
): Promise<FlodeskSubscriber | null> {
  const json = await flodeskFetch(
    `/subscribers/${encodeURIComponent(email.toLowerCase())}`,
    { allow404: true },
  );
  if (json === null) return null;
  return parseSubscriber(json);
}

export interface ListSubscribersPage {
  subscribers: FlodeskSubscriber[];
  page: number;
  totalPages: number | null;
}

export interface ListSubscribersOptions {
  segmentId?: string;
  /** Server-side status filter (e.g. "unsubscribed") when supported. */
  status?: string;
  page?: number;
  perPage?: number;
}

/**
 * List subscribers (one page). Tolerates Flodesk returning the rows either
 * under `data` or at the top level, and pagination meta under a few common
 * shapes (`meta.total_pages` / `total_pages` / `meta.pagination.*`).
 */
export async function listSubscribers(
  opts: ListSubscribersOptions = {},
): Promise<ListSubscribersPage> {
  const page = Math.max(opts.page ?? 1, 1);
  const sp = new URLSearchParams();
  if (opts.segmentId) sp.set("segment_id", opts.segmentId);
  if (opts.status) sp.set("status", opts.status);
  sp.set("page", String(page));
  sp.set("per_page", String(Math.min(Math.max(opts.perPage ?? 100, 1), 100)));

  const json = (await flodeskFetch(`/subscribers?${sp.toString()}`)) ?? {};
  const rowsRaw = Array.isArray((json as { data?: unknown }).data)
    ? (json as { data: unknown[] }).data
    : Array.isArray(json)
      ? (json as unknown[])
      : [];
  const subscribers: FlodeskSubscriber[] = [];
  for (const r of rowsRaw) {
    const s = parseSubscriber(r);
    if (s) subscribers.push(s);
  }

  const meta = (json as { meta?: unknown }).meta;
  let totalPages: number | null = null;
  const readNum = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    totalPages =
      readNum(m["total_pages"]) ??
      (m["pagination"] && typeof m["pagination"] === "object"
        ? readNum((m["pagination"] as Record<string, unknown>)["total_pages"])
        : null);
  }
  if (totalPages === null) {
    totalPages = readNum((json as Record<string, unknown>)["total_pages"]);
  }

  return { subscribers, page, totalPages };
}

export { logger };
