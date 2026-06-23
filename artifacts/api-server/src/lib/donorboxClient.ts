import { logger } from "./logger";

/**
 * Minimal client for the Donorbox public API (https://donorbox.org/api/v1).
 *
 * Auth: HTTP Basic with the Donorbox account email as the username and the API
 * key as the password (`Authorization: Basic base64("<email>:<key>")`). The
 * account email is a non-secret config value (DONORBOX_USER_EMAIL, falling back
 * to the legacy DONORBOX_API_EMAIL when unset); the API key stays a secret
 * (DONORBOX_API_KEY). Neither is ever logged. Donorbox also requires a
 * descriptive `User-Agent` header.
 *
 * We use it pull-only: list donations (the enrichment + new-money source) and,
 * optionally, recurring plans. The `/donations` endpoint returns a bare JSON
 * array and supports `page`, `per_page` (max 100), and `order` (asc|desc by
 * donation date) — there is no server-side date filter, so the sync worker
 * paginates newest-first and stops once it walks past its watermark.
 *
 * Every parse path is defensive and transient failures (429 / 5xx / network)
 * are retried with linear backoff so a flaky call never throws mid-loop where
 * the caller has chosen to swallow per-item errors.
 */

const DONORBOX_BASE =
  process.env["DONORBOX_API_BASE"] ?? "https://donorbox.org/api/v1";

const USER_AGENT =
  process.env["DONORBOX_USER_AGENT"] ??
  "wildflower-crm (engineering@wildflowerschools.org)";

/** Raised when the API credentials are absent — the caller should fail loudly. */
export class DonorboxNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DonorboxNotConfiguredError";
  }
}

/** Raised for a non-retryable, non-404 HTTP error from Donorbox. */
export class DonorboxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string,
  ) {
    super(`Donorbox ${status} ${path}: ${body.slice(0, 500)}`);
    this.name = "DonorboxApiError";
  }
}

/**
 * Resolve the Donorbox account email from config: the non-secret
 * `DONORBOX_USER_EMAIL`, falling back to the legacy `DONORBOX_API_EMAIL` secret
 * for environments that haven't migrated yet.
 */
function getConfiguredEmail(): string | undefined {
  return (
    process.env["DONORBOX_USER_EMAIL"]?.trim() ||
    process.env["DONORBOX_API_EMAIL"]?.trim() ||
    undefined
  );
}

/** True when both the account email and the API key are configured. */
export function isDonorboxConfigured(): boolean {
  return !!getConfiguredEmail() && !!process.env["DONORBOX_API_KEY"]?.trim();
}

/** Resolve credentials from the environment; throw loudly when missing. */
function getCredentials(): { email: string; key: string } {
  const email = getConfiguredEmail();
  const key = process.env["DONORBOX_API_KEY"]?.trim();
  if (!email || !key) {
    throw new DonorboxNotConfiguredError(
      "DONORBOX_USER_EMAIL (or legacy DONORBOX_API_EMAIL) / DONORBOX_API_KEY are not set — cannot reach Donorbox.",
    );
  }
  return { email, key };
}

function authHeader(): string {
  const { email, key } = getCredentials();
  return `Basic ${Buffer.from(`${email}:${key}`).toString("base64")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DonorboxFetchOptions {
  method?: string;
  timeoutMs?: number;
  retries?: number;
  /** Treat a 404 as "not found" (return null) instead of throwing. */
  allow404?: boolean;
}

/**
 * Perform one Donorbox request with linear-backoff retry on transient failures.
 * Returns the parsed JSON body (whatever shape — Donorbox `/donations` is a bare
 * array), `null` on an allowed 404, or `null` on an empty 2xx body. Throws
 * DonorboxApiError for non-retryable HTTP errors and rethrows the last network
 * error after exhausting retries.
 */
async function donorboxFetch(
  path: string,
  opts: DonorboxFetchOptions = {},
): Promise<unknown> {
  const {
    method = "GET",
    timeoutMs = 30_000,
    retries = 3,
    allow404 = false,
  } = opts;
  const url = `${DONORBOX_BASE}${path}`;
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
        },
      });

      if (res.status === 404 && allow404) return null;

      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          const ra = Number(res.headers.get("retry-after"));
          const waitMs =
            Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * (attempt + 1);
          await sleep(waitMs);
          continue;
        }
        const text = await res.text();
        throw new DonorboxApiError(res.status, path, text);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new DonorboxApiError(res.status, path, text);
      }

      const text = await res.text();
      if (!text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch (err) {
      if (err instanceof DonorboxApiError) throw err;
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ── Parsing helpers ──────────────────────────────────────────────────────

function asStr(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}

/** Coerce a Donorbox money value ("100.0" | 100 | null) to a 2dp string or null. */
function asMoney(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function asDate(v: unknown): Date | null {
  const s = asStr(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A normalized Donorbox donation (a subset of the raw payload we persist). */
export interface DonorboxDonationDTO {
  id: string;
  donationType: string | null;
  stripeChargeId: string | null;
  paypalTransactionId: string | null;
  amount: string | null;
  amountRefunded: string | null;
  processingFee: string | null;
  currency: string | null;
  donationStatus: string | null;
  refunded: boolean;
  recurring: boolean;
  donatedAt: Date | null;
  campaignId: string | null;
  campaignName: string | null;
  designation: string | null;
  comment: string | null;
  anonymous: boolean;
  giftAid: boolean;
  donorName: string | null;
  donorEmail: string | null;
  donorFirstName: string | null;
  donorLastName: string | null;
  donorPhone: string | null;
  donorEmployer: string | null;
  utm: Record<string, string> | null;
  questions: unknown;
  raw: unknown;
}

function parseUtm(raw: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  // Donorbox returns either a nested `utm_codes`/`utm` object or flat utm_* keys.
  const nested = raw["utm_codes"] ?? raw["utm"];
  if (nested && typeof nested === "object") {
    for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
      const s = asStr(v);
      if (s) out[k] = s;
    }
  }
  for (const k of Object.keys(raw)) {
    if (k.startsWith("utm_") && k !== "utm_codes") {
      const s = asStr(raw[k]);
      if (s) out[k] = s;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Normalize a raw Donorbox donation object, or null if it has no id. */
export function parseDonation(raw: unknown): DonorboxDonationDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = asStr(r["id"]);
  if (!id) return null;

  const campaign = (r["campaign"] ?? {}) as Record<string, unknown>;
  const donor = (r["donor"] ?? {}) as Record<string, unknown>;

  const donationStatus = asStr(r["status"]);
  const amountRefunded = asMoney(r["amount_refunded"]);
  const refunded =
    donationStatus?.toLowerCase() === "refunded" ||
    (amountRefunded !== null && Number(amountRefunded) > 0);

  const donorFirst = asStr(donor["first_name"]);
  const donorLast = asStr(donor["last_name"]);
  const donorName =
    asStr(donor["name"]) ??
    ([donorFirst, donorLast].filter(Boolean).join(" ").trim() || null);

  return {
    id,
    donationType: asStr(r["donation_type"]),
    stripeChargeId: asStr(r["stripe_charge_id"]),
    paypalTransactionId:
      asStr(r["paypal_transaction_id"]) ?? asStr(r["paypal_txn_id"]),
    amount: asMoney(r["amount"]),
    amountRefunded,
    processingFee: asMoney(r["processing_fee"]),
    currency: asStr(r["currency"]),
    donationStatus,
    refunded,
    recurring: asBool(r["recurring"]),
    donatedAt: asDate(r["donation_date"]),
    campaignId: asStr(campaign["id"]),
    campaignName: asStr(campaign["name"]),
    designation:
      asStr(r["designation"]) ?? asStr(r["donation_for_designation"]),
    comment: asStr(r["comment"]),
    anonymous: asBool(r["anonymous"] ?? r["anonymous_donation"]),
    giftAid: asBool(r["gift_aid"]),
    donorName,
    donorEmail: asStr(donor["email"])?.toLowerCase() ?? null,
    donorFirstName: donorFirst,
    donorLastName: donorLast,
    donorPhone: asStr(donor["phone"]),
    donorEmployer: asStr(donor["employer"]) ?? asStr(r["employer"]),
    utm: parseUtm(r),
    questions: r["questions"] ?? null,
    raw,
  };
}

export interface ListDonationsOptions {
  page?: number;
  perPage?: number;
  /** Donation-date order. Default "desc" (newest first) for incremental walks. */
  order?: "asc" | "desc";
  /** Optional server-side filters Donorbox supports as passthroughs. */
  email?: string;
  campaignId?: string | number;
}

/**
 * List one page of donations (a bare array). Tolerates Donorbox returning the
 * rows either at the top level or wrapped under `data`/`donations`.
 */
export async function listDonations(
  opts: ListDonationsOptions = {},
): Promise<DonorboxDonationDTO[]> {
  const page = Math.max(opts.page ?? 1, 1);
  const sp = new URLSearchParams();
  sp.set("page", String(page));
  sp.set("per_page", String(Math.min(Math.max(opts.perPage ?? 100, 1), 100)));
  sp.set("order", opts.order ?? "desc");
  if (opts.email) sp.set("email", opts.email);
  if (opts.campaignId !== undefined)
    sp.set("campaign_id", String(opts.campaignId));

  const json = await donorboxFetch(`/donations?${sp.toString()}`);
  const rows = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown })?.data)
      ? (json as { data: unknown[] }).data
      : Array.isArray((json as { donations?: unknown })?.donations)
        ? (json as { donations: unknown[] }).donations
        : [];

  const out: DonorboxDonationDTO[] = [];
  for (const r of rows) {
    const d = parseDonation(r);
    if (d) out.push(d);
  }
  return out;
}

/**
 * List one page of recurring plans (raw passthrough). Deferred from active use
 * (no donorbox_plans table yet) but kept for completeness / future enrichment.
 */
export async function listPlans(
  opts: { page?: number; perPage?: number } = {},
): Promise<unknown[]> {
  const page = Math.max(opts.page ?? 1, 1);
  const sp = new URLSearchParams();
  sp.set("page", String(page));
  sp.set("per_page", String(Math.min(Math.max(opts.perPage ?? 100, 1), 100)));
  const json = await donorboxFetch(`/plans?${sp.toString()}`);
  if (Array.isArray(json)) return json;
  if (Array.isArray((json as { data?: unknown })?.data))
    return (json as { data: unknown[] }).data;
  if (Array.isArray((json as { plans?: unknown })?.plans))
    return (json as { plans: unknown[] }).plans;
  return [];
}

export { logger };
