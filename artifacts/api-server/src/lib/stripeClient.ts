import Stripe from "stripe";
// Type-only alias: under CJS-view type resolution the default export is the
// callable constructor namespace, not a type; the named `Stripe` is the
// instance type under both module views.
import type { Stripe as StripeClient } from "stripe";
import { logger } from "./logger";

/**
 * Stripe access via either a restricted live API key or the Replit connector
 * proxy.
 *
 * Preferred credential: a Restricted, read-only LIVE Stripe API key supplied in
 * the `STRIPE_RESTRICTED_KEY` secret. The Replit Stripe connector only ever
 * authorizes in test/sandbox mode, so it cannot read Wildflower's real live
 * account; the restricted key is how we pull the real charges/payouts needed for
 * finance reconciliation. The sync is strictly pull-only and the key is
 * read-only, so this is the safe, correct credential.
 *
 * Fallback credential: the Replit connector proxy. Unlike QuickBooks (OAuth
 * tokens stored + refreshed in quickbooks_connections), connector Stripe
 * credentials are served fresh by the proxy on every call. We therefore NEVER
 * cache the connector client or secret: the proxy resolves to the org's TEST
 * sandbox in development and to the LIVE account in production automatically, so
 * a cached client could leak the wrong-environment key.
 *
 * The connector secret lives at connection `settings.secret` (NOT `secret_key`);
 * the account id at `settings.account_id`. We read defensively across a couple
 * of field names so a connector schema tweak doesn't break us.
 *
 * The restricted key never gets logged; only the active mode (connector vs
 * restricted key) and the derived account id are logged.
 */

interface StripeCredentials {
  secret: string;
  accountId: string | null;
}

function getRestrictedKey(): string | null {
  const key = process.env.STRIPE_RESTRICTED_KEY?.trim();
  return key ? key : null;
}

function getReplitToken(): string | null {
  if (process.env.REPL_IDENTITY) return `repl ${process.env.REPL_IDENTITY}`;
  if (process.env.WEB_REPL_RENEWAL) return `depl ${process.env.WEB_REPL_RENEWAL}`;
  return null;
}

/**
 * Cheap, side-effect-free check used by the scheduler / no-op gates. True when
 * the connector proxy env is present; does NOT prove a Stripe account is linked.
 */
export function stripeConnectorAvailable(): boolean {
  return Boolean(process.env.REPLIT_CONNECTORS_HOSTNAME && getReplitToken());
}

/**
 * Cheap, side-effect-free check used by the scheduler / no-op gates. True when
 * Stripe can be reached at all — either via the restricted live key or the
 * connector proxy. Presence of `STRIPE_RESTRICTED_KEY` counts as "configured"
 * so scheduled + on-demand syncs run when only the secret is set.
 */
export function stripeConfigured(): boolean {
  return Boolean(getRestrictedKey()) || stripeConnectorAvailable();
}

async function fetchStripeCredentials(): Promise<StripeCredentials> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = getReplitToken();
  if (!hostname || !token) {
    throw new Error(
      "Stripe connector unavailable: missing REPLIT_CONNECTORS_HOSTNAME or repl identity token",
    );
  }

  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: token } },
  );
  if (!res.ok) {
    throw new Error(`Stripe connector proxy returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    items?: { settings?: Record<string, unknown> }[];
  };
  const settings = data.items?.[0]?.settings ?? {};
  const secret =
    (settings.secret as string | undefined) ||
    (settings.secret_key as string | undefined) ||
    (settings.api_key as string | undefined);
  const accountId =
    (settings.account_id as string | undefined) ??
    (settings.accountId as string | undefined) ??
    null;

  if (!secret) {
    throw new Error(
      "Stripe is not connected (no secret in connector settings) — connect Stripe in the integrations panel",
    );
  }
  return { secret, accountId };
}

function buildStripe(secret: string): StripeClient {
  return new Stripe(secret, {
    appInfo: { name: "wildflower-crm" },
    maxNetworkRetries: 2,
  });
}

// The restricted key authenticates one fixed account and is sourced from a
// static secret, so its derived account id is stable. Cache only the id string
// (never the client/secret) to avoid an accounts.retrieve roundtrip per call.
let restrictedAccountIdCache: string | null = null;
let loggedRestrictedMode = false;

// A read-only restricted key may lack the "Basic Business Contact Information
// Read" scope that accounts.retrieveCurrent needs. In that case Stripe still
// names the owning account in the permission error (message + request_log_url),
// so we recover the `acct_…` id from there — no extra scope required.
function extractAccountId(err: unknown): string | null {
  const e = err as { raw?: { message?: string; request_log_url?: string }; message?: string };
  const sources = [
    e?.raw?.request_log_url,
    e?.raw?.message,
    e?.message,
  ];
  for (const src of sources) {
    const m = typeof src === "string" ? src.match(/acct_[A-Za-z0-9]+/) : null;
    if (m) return m[0];
  }
  return null;
}

async function deriveRestrictedAccountId(stripe: StripeClient): Promise<string | null> {
  if (restrictedAccountIdCache) return restrictedAccountIdCache;
  try {
    const account = await stripe.accounts.retrieveCurrent();
    if (account.id) {
      restrictedAccountIdCache = account.id;
      return account.id;
    }
  } catch (err) {
    const recovered = extractAccountId(err);
    if (recovered) {
      restrictedAccountIdCache = recovered;
      return recovered;
    }
    logger.warn(
      { err },
      "Stripe restricted key: could not derive account id (key needs read access to payouts/charges and ideally Account read)",
    );
  }
  return null;
}

/**
 * Build a fresh Stripe SDK client + the connected account id. Call this on every
 * sync run / request — never store the returned client. The secret is never
 * logged.
 *
 * Prefers the restricted live key (`STRIPE_RESTRICTED_KEY`) when present, so the
 * real account is read for reconciliation; otherwise falls back to the connector
 * proxy (test sandbox in dev, live in prod). The mode is logged once; the secret
 * is never logged.
 */
export async function getUncachableStripeClient(): Promise<{
  stripe: StripeClient;
  accountId: string | null;
}> {
  const restricted = getRestrictedKey();
  if (restricted) {
    const stripe = buildStripe(restricted);
    const accountId = await deriveRestrictedAccountId(stripe);
    if (!loggedRestrictedMode) {
      loggedRestrictedMode = true;
      logger.info(
        { mode: "restricted_key", accountId },
        "Stripe client: using restricted live key",
      );
    }
    return { stripe, accountId };
  }

  const { secret, accountId } = await fetchStripeCredentials();
  const stripe = buildStripe(secret);
  return { stripe, accountId };
}
