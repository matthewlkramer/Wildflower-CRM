import Stripe from "stripe";

/**
 * Stripe access via the Replit connector proxy.
 *
 * Unlike QuickBooks (OAuth tokens stored + refreshed in quickbooks_connections),
 * Stripe credentials are served fresh by the Replit connector proxy on every
 * call. We therefore NEVER cache the client or the secret: the proxy resolves to
 * the org's TEST sandbox in development and to the LIVE account in production
 * automatically, so a cached client could leak the wrong-environment key.
 *
 * The secret lives at connection `settings.secret` (NOT `secret_key`); the
 * account id at `settings.account_id`. We read defensively across a couple of
 * field names so a connector schema tweak doesn't break us.
 */

interface StripeCredentials {
  secret: string;
  accountId: string | null;
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

/**
 * Build a fresh Stripe SDK client + the connected account id. Call this on every
 * sync run / request — never store the returned client. The secret is never
 * logged.
 */
export async function getUncachableStripeClient(): Promise<{
  stripe: Stripe;
  accountId: string | null;
}> {
  const { secret, accountId } = await fetchStripeCredentials();
  const stripe = new Stripe(secret, {
    appInfo: { name: "wildflower-crm" },
    maxNetworkRetries: 2,
  });
  return { stripe, accountId };
}
