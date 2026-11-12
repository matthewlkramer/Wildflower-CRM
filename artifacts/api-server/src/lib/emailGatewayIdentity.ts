import { createHash } from "node:crypto";
import { trackedEmails } from "@workspace/db/schema";
import { sql } from "drizzle-orm";

export const GATEWAY_DELIVERY_PREFIX = "gateway-delivery:";

export function gatewaySenderEnabled(sender: string): boolean {
  const allowed = process.env.WFCRM_EMAIL_GATEWAY_SENDERS ?? "";
  return allowed.split(/[\s,]+/).some((address) => address.toLowerCase() === sender.toLowerCase());
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

export function gatewayDeliveryVisibility(viewerId: string) {
  return sql`(NOT (${isGatewayDelivery}) OR EXISTS (
    SELECT 1 FROM email_messages AS source_email
    WHERE source_email.gmail_message_id = ${trackedEmails.gmailMessageId}
      AND source_email.direction = 'sent'
      AND lower(source_email.from_email) = lower(${trackedEmails.sender})
      AND (source_email.is_private = false OR source_email.mailbox_user_id = ${viewerId})
  ))`;
}
