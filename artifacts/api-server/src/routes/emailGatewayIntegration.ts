import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@workspace/db";
import {
  emailMessages,
  emailSyncSkip,
  googleOauthTokens,
  trackedEmails,
  trackedEmailViews,
  users,
} from "@workspace/db/schema";
import {
  CheckEmailGatewayEligibilityBody,
  ImportEmailGatewayDeliveryBody,
} from "@workspace/api-zod";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { isMatchEmpty, matchEmails } from "../lib/emailMatcher";
import {
  GATEWAY_DELIVERY_PREFIX,
  gatewayGroupId,
  gatewaySenderEnabled,
  gatewayWorkspaceDomain,
} from "../lib/emailGatewayIdentity";
import { getHeader, getMessage, listMessageIds } from "../lib/gmail";
import { GMAIL_READ_SCOPE } from "../lib/googleOauth";
import { getValidGoogleAccessTokenForUser } from "../lib/googleTokenStore";
import { asyncHandler } from "../lib/helpers";

const router: IRouter = Router();

function digest(token: string) {
  return createHash("sha256").update(token).digest();
}

const gatewayPath = "/integrations/email-gateway";

router.use(gatewayPath, (req, res, next) => {
  const token = process.env.WFCRM_EMAIL_GATEWAY_TOKEN?.trim();
  if (!token) {
    res.status(503).json({ error: "email_gateway_not_configured" });
    return;
  }
  const supplied = /^Bearer ([^\s]+)$/i.exec(
    req.get("authorization") ?? "",
  )?.[1];
  if (!supplied || !timingSafeEqual(digest(supplied), digest(token))) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

async function connectedMailboxes(sender?: string) {
  const email = sql<string>`lower(${googleOauthTokens.googleEmail})`;
  return db
    .select({ email, userId: sql<string>`min(${users.id})` })
    .from(googleOauthTokens)
    .innerJoin(users, eq(users.id, googleOauthTokens.userId))
    .where(
      and(
        sender ? sql`${email} = ${sender}` : undefined,
        isNotNull(googleOauthTokens.googleEmail),
        isNotNull(googleOauthTokens.grantedAt),
        isNotNull(googleOauthTokens.accessTokenEnc),
        isNotNull(googleOauthTokens.refreshTokenEnc),
        isNull(googleOauthTokens.revokedAt),
        isNull(users.archivedAt),
        gatewayWorkspaceDomain()
          ? sql`${GMAIL_READ_SCOPE} = ANY(string_to_array(${googleOauthTokens.scope}, ' '))`
          : undefined,
      ),
    )
    .groupBy(email)
    .having(sql`count(*) = 1`);
}

async function connectedMailbox(sender: string): Promise<string | null> {
  if (!gatewaySenderEnabled(sender)) return null;
  const [owner] = await connectedMailboxes(sender);
  return owner?.userId ?? null;
}

router.post(
  `${gatewayPath}/connected-senders`,
  asyncHandler(async (_req, res) => {
    if (!gatewayWorkspaceDomain()) {
      res.status(503).json({ error: "email_gateway_enrollment_not_configured" });
      return;
    }
    const mailboxes = await connectedMailboxes();
    res.set("Cache-Control", "no-store");
    res.json({ senders: mailboxes.map(({ email }) => email).filter(gatewaySenderEnabled).sort() });
  }),
);

router.post(
  `${gatewayPath}/eligibility`,
  asyncHandler(async (req, res) => {
    const parsed = CheckEmailGatewayEligibilityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_email_gateway_eligibility" });
      return;
    }
    const sender = parsed.data.sender.toLowerCase();
    const owner = await connectedMailbox(sender);
    const eligible =
      !!owner &&
      !isMatchEmpty(await matchEmails(parsed.data.recipients, sender));
    res.json({ eligible });
  }),
);

router.post(
  `${gatewayPath}/deliveries`,
  asyncHandler(async (req, res) => {
    const parsed = ImportEmailGatewayDeliveryBody.safeParse(req.body);
    if (
      !parsed.success ||
      parsed.data.events.some((event) => !Number.isSafeInteger(event.id))
    ) {
      res.status(400).json({ error: "invalid_email_gateway_delivery" });
      return;
    }
    const { deliveryId, messageId, events } = parsed.data;
    const sender = parsed.data.sender.toLowerCase();
    const recipient = parsed.data.recipient.toLowerCase();
    const trackingId = `${GATEWAY_DELIVERY_PREFIX}${deliveryId}`;
    const mailboxUserId = await connectedMailbox(sender);
    if (!mailboxUserId) {
      res.json({ status: "out_of_scope" });
      return;
    }
    // The SMTP Message-ID is not Gmail's mailbox-local API ID. Resolve the
    // exact Sent message, including verifying the header returned by Gmail.
    const grant = await getValidGoogleAccessTokenForUser(mailboxUserId);
    if (!grant || grant.googleEmail.toLowerCase() !== sender) {
      res.json({ status: "out_of_scope" });
      return;
    }
    const candidates = await listMessageIds(grant.accessToken, {
      q: `in:sent rfc822msgid:${messageId}`,
      maxResults: 2,
    });
    if (candidates.messages.length === 0) {
      res.json({ status: "pending_sync" });
      return;
    }
    if (candidates.messages.length !== 1 || candidates.nextPageToken) {
      res.json({ status: "out_of_scope" });
      return;
    }
    const gmail = await getMessage(
      grant.accessToken,
      candidates.messages[0]!.id,
      "metadata",
    );
    if (
      !gmail.labelIds?.includes("SENT") ||
      getHeader(gmail.payload, "Message-ID")?.trim() !== messageId
    ) {
      res.json({ status: "out_of_scope" });
      return;
    }

    const [sent] = await db
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.mailboxUserId, mailboxUserId),
          eq(emailMessages.gmailMessageId, gmail.id),
          eq(emailMessages.direction, "sent"),
        ),
      );
    if (!sent) {
      const [skip] = await db
        .select({ id: emailSyncSkip.gmailMessageId })
        .from(emailSyncSkip)
        .where(
          and(
            eq(emailSyncSkip.mailboxUserId, mailboxUserId),
            eq(emailSyncSkip.gmailMessageId, gmail.id),
          ),
        );
      res.json({ status: skip ? "out_of_scope" : "pending_sync" });
      return;
    }
    if (
      sent.fromEmail?.trim().toLowerCase() !== sender ||
      ![...(sent.toEmails ?? []), ...(sent.ccEmails ?? [])].some(
        (address) => address.trim().toLowerCase() === recipient,
      )
    ) {
      res.json({ status: "out_of_scope" });
      return;
    }

    const links = await matchEmails([recipient], sender, sent.sentAt);
    const groupId = gatewayGroupId(mailboxUserId, gmail.id);
    const imported = await db.transaction(async (tx) => {
      await tx
        .insert(trackedEmails)
        .values({
          id: trackingId,
          groupId,
          subject: sent.subject ?? "",
          recipient,
          sender,
          gmailMessageId: gmail.id,
          gmailThreadId: gmail.threadId,
          createdAt: sent.sentAt,
          recipientPersonIds: links.personIds,
          recipientOrganizationIds: links.organizationIds,
          recipientHouseholdIds: links.householdIds,
        })
        .onConflictDoNothing({ target: trackedEmails.id });
      const [record] = await tx
        .select({
          groupId: trackedEmails.groupId,
          recipient: trackedEmails.recipient,
        })
        .from(trackedEmails)
        .where(eq(trackedEmails.id, trackingId));
      if (record?.groupId !== groupId || record.recipient !== recipient)
        return false;
      if (events.length > 0) {
        await tx
          .insert(trackedEmailViews)
          .values(
            events.map((event) => ({
              id: `gateway-open:${deliveryId}:${event.id}`,
              emailId: trackingId,
              viewedAt: new Date(event.observedAt),
            })),
          )
          .onConflictDoNothing({ target: trackedEmailViews.id });
      }
      return true;
    });
    if (!imported) {
      res.status(409).json({ error: "email_gateway_delivery_conflict" });
      return;
    }
    res.json({ status: "imported" });
  }),
);

export default router;
