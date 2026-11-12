import { createHash } from "node:crypto";
import { trackedEmails } from "@workspace/db/schema";
import { sql, type SQLWrapper } from "drizzle-orm";

export const GATEWAY_DELIVERY_PREFIX = "gateway-delivery:";

export function gatewayWorkspaceDomain(): string | undefined {
  return process.env.WFCRM_EMAIL_GATEWAY_WORKSPACE_DOMAIN?.trim().toLowerCase() || undefined;
}

export function gatewaySenderEnabled(sender: string): boolean {
  const domain = gatewayWorkspaceDomain();
  if (domain) {
    const [local, host, extra] = sender.toLowerCase().split("@");
    return !!local && /^[a-z0-9._%+-]+$/.test(local) && host === domain && extra === undefined;
  }
  const allowed = process.env.WFCRM_EMAIL_GATEWAY_SENDERS ?? "";
  return !!sender && allowed.split(/[\s,]+/).some((address) => address.toLowerCase() === sender.toLowerCase());
}

export function gatewayGroupId(
  mailboxUserId: string,
  gmailMessageId: string,
): string {
  return `gateway-group:${createHash("sha256")
    .update(JSON.stringify([mailboxUserId, gmailMessageId]))
    .digest("base64url")}`;
}

export const isGatewayDelivery = sql`${trackedEmails.id} LIKE ${`${GATEWAY_DELIVERY_PREFIX}%`}`;

function gatewaySourceMatches(condition: SQLWrapper) {
  return sql`EXISTS (
    SELECT 1 FROM email_messages AS source_email
    WHERE source_email.gmail_message_id = ${trackedEmails.gmailMessageId}
      AND source_email.direction = 'sent'
      AND lower(source_email.from_email) = lower(${trackedEmails.sender})
      AND (${condition})
  )`;
}

export function gatewayDeliveryVisibility(viewerId: string) {
  return sql`(NOT (${isGatewayDelivery}) OR ${gatewaySourceMatches(
    sql`source_email.is_private = false OR source_email.mailbox_user_id = ${viewerId}`,
  )})`;
}

export function trackingMailboxMatches(userId: string | SQLWrapper, loginEmail: string | SQLWrapper) {
  return sql`CASE WHEN ${isGatewayDelivery}
    THEN ${gatewaySourceMatches(sql`source_email.mailbox_user_id = ${userId}`)}
    ELSE lower(${trackedEmails.sender}) = lower(${loginEmail}) END`;
}
